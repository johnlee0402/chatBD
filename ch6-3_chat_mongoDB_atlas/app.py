import os

# ⚠️ eventlet 必須在「其他所有 import 之前」patch，否則部分 I/O（檔案、socket）會阻塞整個伺服器
os.environ.setdefault("EVENTLET_NO_GREENDNS", "1")  # 避免 eventlet 的 DNS 與 SSL 衝突（雲端部署常見）
import eventlet

eventlet.monkey_patch()

import re
import json
import uuid
from datetime import datetime, timezone

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit

app = Flask(__name__)

# 🔌 初始化 Socket.IO（使用 eventlet 異步模式）
# - cors_allowed_origins="*"：允許跨網域，方便本地/雲端測試；正式環境可改成特定網域以提升安全性
# - async_mode="eventlet"：配合 eventlet 的協程模型（高併發友善）
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")


# === 根路由 ===
@app.route("/")
def index():
    # 回傳首頁樣板（templates/index.html）
    return render_template("index.html")


# === 聊天歷史設定 ===
MAX_HISTORY = 100                      # 記憶體/檔案最多保留的訊息數（避免檔案無限成長）
MAX_NAME_LEN = 30                      # 暱稱長度上限
MAX_MESSAGE_LEN = 5000                 # 單則訊息長度上限（前端也有同樣的檢查）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))     # app.py 所在的資料夾
HISTORY_DIR = os.path.join(BASE_DIR, "chat_history")      # 不管從哪裡執行，都存在 app.py 旁邊
HISTORY_FILE = os.path.join(HISTORY_DIR, "messages.json")  # JSON 落盤位置
os.makedirs(HISTORY_DIR, exist_ok=True)                    # 沒資料夾就建立

# 根據 async_mode 選用正確的鎖
if socketio.async_mode == "eventlet":
    from eventlet.semaphore import Semaphore
    _history_lock = Semaphore(1)  # eventlet 的輕量鎖（合作式排程友善）
else:
    import threading
    _history_lock = threading.Lock()

chat_history = []  # in-memory 緩存：加速讀取 /get_history，並作為寫入檔案的來源


def _load_chat_history():
    """啟動時載入歷史檔案到記憶體；任何錯誤都改用空陣列，不讓服務掛掉"""
    if not os.path.exists(HISTORY_FILE):
        return
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            chat_history.extend(data[-MAX_HISTORY:])
    except Exception as e:
        print(f"[history] 讀取失敗：{e}")


def _save_chat_history():
    """將記憶體的 chat_history 寫回磁碟（呼叫端需自行持鎖）"""
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(chat_history, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[history] 寫入失敗：{e}")


_load_chat_history()


# === 輸入清理工具 ===
def _as_dict(data):
    """前端送來的 payload 不一定是物件（可能是字串或 None），統一轉成 dict"""
    return data if isinstance(data, dict) else {}


def _clean_name(value, default="匿名"):
    """去頭尾空白、把連續空白壓成一個、限制長度；空字串就回傳 default"""
    name = re.sub(r"\s+", " ", str(value or "")).strip()[:MAX_NAME_LEN]
    return name or default


def _clean_client_id(value):
    """前端產生的 clientId，用來判斷「這則訊息是不是我發的」"""
    cid = str(value or "").strip()[:64]
    return cid or None


def _utc_now_iso():
    """UTC ISO 字串，結尾用 Z，例如 2026-11-06T03:20:00Z"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# === 使用者連線狀態 ===
# 例：{"<sid>": {"username": "小明", "client_id": "..."}}
clients = {}


def broadcast_user_count():
    """只計算「已 join（有名稱）」的連線數並廣播"""
    emit(
        "user_count",
        {"count": len([c for c in clients.values() if c.get("username")])},
        broadcast=True,
    )


@socketio.on("connect")
def on_connect():
    clients[request.sid] = {"username": None, "client_id": None}
    print("Client connect:", request.sid)


@socketio.on("disconnect")
def on_disconnect():
    info = clients.pop(request.sid, None)
    if info and info.get("username"):
        emit("user_left", {"username": info["username"]}, broadcast=True)
        broadcast_user_count()
    print("Client disconnect:", request.sid)


@socketio.on("join")
def on_join(data):
    """
    使用者宣告加入（前端每次連線/重連成功都會送一次）
    回傳值會成為前端 emit 的 ack，讓前端知道伺服器實際記錄的名稱
    """
    data = _as_dict(data)
    username = _clean_name(data.get("username"))
    info = clients.setdefault(request.sid, {"username": None, "client_id": None})
    info["username"] = username
    info["client_id"] = _clean_client_id(data.get("clientId"))

    emit("user_joined", {"username": username}, broadcast=True)
    broadcast_user_count()
    print(username, "joined")
    return {"username": username}


@socketio.on("typing")
def on_typing(data):
    """只轉發伺服器記錄的名稱，不轉發前端送來的任意內容"""
    info = clients.get(request.sid)
    if not info or not info.get("username"):
        return
    emit("typing", {"username": info["username"]}, broadcast=True, include_self=False)


@socketio.on("change_username")
def on_change(data):
    """
    變更名稱：舊名稱以伺服器記錄為準（不信任前端送來的 oldUsername）
    回傳 {"ok": bool, "username"/"message"} 給前端的 ack
    """
    data = _as_dict(data)
    info = clients.get(request.sid)
    if not info or not info.get("username"):
        return {"ok": False, "message": "尚未加入聊天"}

    old = info["username"]
    new = _clean_name(data.get("newUsername"), default="")
    if not new:
        return {"ok": False, "message": "名稱不可空白"}
    if new == old:
        return {"ok": True, "username": old}

    info["username"] = new
    emit("user_changed_name", {"oldUsername": old, "newUsername": new}, broadcast=True)
    return {"ok": True, "username": new}


# === 文字訊息主流程：寫入歷史 → 廣播 ===
@socketio.on("send_message")
def on_message(data):
    try:
        data = _as_dict(data)
        info = clients.get(request.sid) or {}
        username = info.get("username") or _clean_name(data.get("username"))
        client_id = info.get("client_id") or _clean_client_id(data.get("clientId"))

        raw_content = str(data.get("content", "")).strip()
        # 移除舊格式（若訊息前面曾經自動帶 "user name is ...\ncontent is ..."）
        cleaned_content = re.sub(r"user name is .*?\ncontent is ", "", raw_content, flags=re.IGNORECASE)

        if not cleaned_content:
            return
        if len(cleaned_content) > MAX_MESSAGE_LEN:
            emit("chat_error", {"message": f"訊息太長（上限 {MAX_MESSAGE_LEN} 字），其他人沒有收到"}, to=request.sid)
            return

        message = {
            "id": str(uuid.uuid4()),
            "username": username,
            "clientId": client_id,          # 前端用來判斷「是不是我」，比用名稱可靠
            "content": cleaned_content,
            "timestamp": _utc_now_iso(),
        }

        with _history_lock:
            chat_history.append(message)
            if len(chat_history) > MAX_HISTORY:
                del chat_history[0 : len(chat_history) - MAX_HISTORY]
            _save_chat_history()

        # 前端送出時已先在本地顯示，所以這裡不回傳給自己
        emit("chat_message", message, broadcast=True, include_self=False)

    except Exception as e:
        emit("chat_error", {"message": f"訊息處理失敗，其他人沒有收到：{e}"}, to=request.sid)


# === 歷史 API ===
@app.route("/get_history", methods=["GET"])
def get_history():
    with _history_lock:
        snapshot = list(chat_history)  # 複製一份，避免序列化時被其他協程修改
    return jsonify(snapshot)


@app.route("/clear_history", methods=["POST"])
def clear_history():
    """清空歷史，並廣播 history_cleared 讓「所有人」的畫面一起清空"""
    with _history_lock:
        chat_history.clear()
        try:
            if os.path.exists(HISTORY_FILE):
                os.remove(HISTORY_FILE)
        except Exception as e:
            return jsonify({"status": "error", "message": f"刪除檔案失敗: {e}"}), 500

    socketio.emit("history_cleared", {})
    return jsonify({"status": "success", "message": "歷史紀錄已清除"})


if __name__ == "__main__":
    # 雲端（如 Render）會用環境變數 PORT 指定埠號
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("FLASK_DEBUG", "1") == "1"  # 正式環境請設 FLASK_DEBUG=0
    socketio.run(app, host="0.0.0.0", port=port, debug=debug)