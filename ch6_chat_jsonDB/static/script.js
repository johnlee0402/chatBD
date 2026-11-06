/* ========= Mermaid 初始化 ========= */
/**
 * startOnLoad=false：不在頁面載入時自動渲染，訊息插入後由 renderCode() 手動觸發
 * securityLevel="strict"：禁止圖表內嵌 HTML/點擊腳本
 */
mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

/* ===== 常數 ===== */
const MAX_MESSAGE_LEN = 5000; // 與後端 MAX_MESSAGE_LEN 一致

/* ===== 使用者身分 ===== */
/**
 * - username：顯示用的暱稱（可以重複、可以改）
 * - clientId：這個分頁專屬的隨機 id，用來判斷「訊息是不是我發的」
 *   （只用名稱判斷的話，兩個人同名就會互相把對方訊息當成自己的）
 * 都存在 sessionStorage：同一分頁重新整理會保留，關掉分頁就清掉
 */
function makeId() {
  // crypto.randomUUID 只在 https 或 localhost 可用，其他情況改用備援
  if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

let username = sessionStorage.getItem("chat_username");
if (!username) {
  username = "使用者" + Math.floor(Math.random() * 1000);
  sessionStorage.setItem("chat_username", username);
}

let clientId = sessionStorage.getItem("chat_client_id");
if (!clientId) {
  clientId = makeId();
  sessionStorage.setItem("chat_client_id", clientId);
}

function setUsername(name) {
  username = name;
  sessionStorage.setItem("chat_username", name);
}

/* ===== 安全工具 ===== */
/** 把使用者提供的文字轉成安全的 HTML 文字（名稱、時間等都要經過這裡） */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

/** 把 &lt; &amp; 之類的實體還原成原文（DOMParser 不會執行任何腳本，可安全使用） */
function decodeEntities(s) {
  return new DOMParser().parseFromString(s, "text/html").documentElement.textContent;
}

/* ===== 發訊息 ===== */
$("#send-button").on("click", send);
$("#message-input").on("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

/* ========= 滑到底部 ========= */
function scrollBottom() {
  const m = document.getElementById("chat-messages");
  m.scrollTop = m.scrollHeight;
}

/** 讓「正在輸入」提示永遠留在訊息區最下方 */
function keepTypingAtBottom() {
  $("#chat-messages").append($("#chat-messages .typing-indicator"));
}

/* ===== Markdown / Mermaid / Highlight ===== */
/**
 * 將訊息文字格式化為 HTML：
 * 1) marked 把 Markdown 轉 HTML（程式碼內容此時是跳脫過的，例如 &lt;）
 * 2) 把 mermaid 與一般程式碼區塊包上複製按鈕
 *    - 要複製的原文放在 data-code（encodeURIComponent 後放進屬性，不用 onclick）
 *    - 區塊內容「保持跳脫」，Mermaid 讀取時會自行還原
 * 3) 最後才用 DOMPurify 清理整段 HTML —— 清理之後不能再動它，否則會重新打開 XSS 漏洞
 */
function format(txt) {
  let html = marked.parse(String(txt ?? "").trim());

  // ```mermaid``` → Mermaid 容器
  html = html.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, (m, c) => {
    const raw = decodeEntities(c);
    return `<div class="mermaid-container">
      <button type="button" class="copy-btn" data-code="${encodeURIComponent(raw)}">複製</button>
      <pre class="mermaid">${c}</pre>
    </div>`;
  });

  // 其他語言的程式碼區塊 → 加複製按鈕
  html = html.replace(/<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g, (m, l, c) => {
    const raw = decodeEntities(c);
    return `<div class="code-block">
      <button type="button" class="copy-btn" data-code="${encodeURIComponent(raw)}">複製</button>
      <pre><code class="language-${l}">${c}</code></pre>
    </div>`;
  });

  return DOMPurify.sanitize(html);
}

/* ===== 執行 Highlight.js 與 Mermaid 渲染 ===== */
/** 只處理還沒處理過的區塊，避免每來一則訊息就把全部重畫一次 */
function renderCode() {
  requestAnimationFrame(() => {
    document
      .querySelectorAll("pre code:not([data-highlighted])")
      .forEach((b) => hljs.highlightElement(b));
    Promise.resolve()
      .then(() => mermaid.init(undefined, ".mermaid:not([data-processed])"))
      .catch((e) => console.warn("Mermaid 渲染失敗：", e));
  });
}

/* ===== 複製按鈕 ===== */
/** navigator.clipboard 只在 https/localhost 可用；其他情況用舊方法備援 */
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy") ? resolve() : reject(new Error("execCommand 失敗"));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}

// 用事件委派：之後新增的訊息裡的按鈕也有效，且不需要 inline onclick
$(document).on("click", ".copy-btn", function () {
  const btn = this;
  const text = decodeURIComponent($(btn).attr("data-code") || "");
  copyToClipboard(text)
    .then(() => {
      btn.innerText = "已複製！";
      setTimeout(() => (btn.innerText = "複製"), 1500);
    })
    .catch(() => alert("複製失敗"));
});

/* ===== 渲染訊息 ===== */
/**
 * - content：訊息文字（支援 Markdown）
 * - isMe：是否為自己
 * - sender：發送者名稱（會先跳脫）
 * - ts：伺服器的 UTC 時間字串；沒有就用現在時間（例如自己剛送出的訊息）
 */
function addMessage(content, isMe, sender, ts) {
  let date = ts ? new Date(ts) : new Date();
  if (isNaN(date)) date = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const html = `
    <div class="message ${isMe ? "user-message" : "other-message"} clearfix">
      ${!isMe ? `<div class="user-info"><span class="user-name">${escapeHtml(sender)}</span></div>` : ""}
      <div class="message-content">${format(content)}</div>
      <div class="message-time">${escapeHtml(time)}</div>
    </div>`;
  $("#chat-messages").append(html);
  keepTypingAtBottom();
  renderCode();
  scrollBottom();
}

/** 系統訊息一律用 .text() 插入，名稱裡就算有 HTML 也不會被執行 */
function addSystem(text) {
  $("<div>").addClass("connection-status").text(text).appendTo("#chat-messages");
  keepTypingAtBottom();
  scrollBottom();
}

/* ===== 伺服器訊息：去重 + 等歷史載入完再顯示 ===== */
/**
 * 頁面載入時，歷史訊息（fetch）和即時訊息（socket）是同時進來的：
 * - 即時訊息先到的話會排在歷史上面 → 先放進 pending，等歷史載完再顯示
 * - 同一則訊息可能同時出現在歷史和即時事件裡 → 用 id 去重
 */
const seenIds = new Set();
const pending = [];
let historyLoaded = false;

function isMine(m) {
  // 新訊息用 clientId 判斷；舊格式的歷史訊息沒有 clientId，退回用名稱判斷
  return m.clientId ? m.clientId === clientId : m.username === username;
}

function renderServerMessage(m) {
  if (m.id) {
    if (seenIds.has(m.id)) return;
    seenIds.add(m.id);
  }
  addMessage(m.content, isMine(m), m.username, m.timestamp);
}

/* ===== 表情選單 ===== */
const EMOJIS = ["😊", "😂", "😍", "👍", "❤️", "😉", "🎉", "👋"];

$(".emoji-btn").on("click", function (e) {
  e.stopPropagation(); // 不讓這次點擊傳到 document，否則選單一打開就被關掉
  if ($(".emoji-menu").length) {
    $(".emoji-menu").remove();
    return;
  }
  const $menu = $('<div class="emoji-menu p-2 bg-white rounded shadow"></div>');
  EMOJIS.forEach((emo) => {
    $('<span class="emoji-item p-1" style="cursor:pointer;font-size:1.5rem;"></span>')
      .text(emo)
      .appendTo($menu);
  });
  $menu.on("click", ".emoji-item", function (ev) {
    ev.stopPropagation();
    const $input = $("#message-input");
    $input.val($input.val() + $(this).text()).trigger("focus");
    $menu.remove();
  });
  $(this).after($menu);
});

// 點選單以外的地方就關閉（常駐監聽，不會只生效一次）
$(document).on("click", (e) => {
  if (!$(e.target).closest(".emoji-menu").length) $(".emoji-menu").remove();
});

/* ===== 連線狀態條 ===== */
let statusTimer = null;
function updateStatus(ok, msg = "已連線") {
  const el = $("#connection-status");
  clearTimeout(statusTimer); // 避免「已連線」的淡出計時器把後來的「斷線」提示藏起來
  el.stop(true, true).show().text(msg);
  if (ok) {
    el.css("background-color", "#d4edda");
    statusTimer = setTimeout(() => el.fadeOut(), 3000);
  } else {
    el.css("background-color", "#f8d7da");
  }
}

updateStatus(false, "連線中…");

/* ===== 連線 ===== */
const socket = io();

/**
 * 每次連線「成功」（包含斷線後自動重連）都重新送 join：
 * 重連後伺服器會拿到新的 sid，不重送的話伺服器就不知道你是誰
 */
socket.on("connect", () => {
  updateStatus(true);
  socket.emit("join", { username, clientId }, (res) => {
    // 伺服器可能修剪過名稱（去空白、截長度），以伺服器為準
    if (res && res.username && res.username !== username) setUsername(res.username);
  });
});
socket.on("disconnect", () => updateStatus(false, "連線中斷"));
socket.on("connect_error", () => updateStatus(false, "連線錯誤"));

/* ===== 線上人數 ===== */
socket.on("user_count", (d) => $("#online-count").text(d.count));

/* ===== 系統事件 ===== */
socket.on("user_joined", (d) => addSystem(`${d.username} 加入了聊天`));
socket.on("user_left", (d) => {
  hideTyping(d.username);
  addSystem(`${d.username} 離開了聊天`);
});
socket.on("user_changed_name", (d) => {
  hideTyping(d.oldUsername);
  addSystem(`${d.oldUsername} 更名為 ${d.newUsername}`);
});

// 伺服器處理失敗時通知（訊息已先顯示在本地，所以要讓使用者知道別人沒收到）
socket.on("chat_error", (d) => addSystem(`⚠️ ${d.message}`));

// 任何人清空歷史，所有人的畫面都一起清空
socket.on("history_cleared", () => {
  $("#chat-messages").empty();
  seenIds.clear();
  typingUsers.forEach((t) => clearTimeout(t.timer));
  typingUsers.clear();
  addSystem("歷史紀錄已清除");
});

/* ===== 送出訊息 ===== */
/**
 * 1) 先在本地畫出自己的訊息（後端廣播時 include_self=False，不會再回傳給自己）
 * 2) 送到伺服器；若失敗會收到 chat_error
 */
function send() {
  const txt = $("#message-input").val().trim();
  if (!txt) return;
  if (txt.length > MAX_MESSAGE_LEN) {
    addSystem(`訊息太長（上限 ${MAX_MESSAGE_LEN} 字），請分段送出`);
    return;
  }
  addMessage(txt, true, username);
  socket.emit("send_message", { username, clientId, content: txt });
  $("#message-input").val("").height("auto");
  scrollBottom();
}

/* ===== 接收別人的訊息 ===== */
socket.on("chat_message", (m) => {
  hideTyping(m.username); // 對方送出了，就把他的「正在輸入」拿掉
  if (!historyLoaded) {
    pending.push(m);
    return;
  }
  renderServerMessage(m);
});

/* ===== 「正在輸入」指示 ===== */
/**
 * 用 Map 以名稱為 key 管理每個人的提示元素與計時器
 * （舊版用名稱拼 class 當 jQuery 選擇器，名稱含 . # 引號等字元時會壞掉）
 */
const typingUsers = new Map(); // username -> { el, timer }

function hideTyping(user) {
  const t = typingUsers.get(user);
  if (!t) return;
  clearTimeout(t.timer);
  t.el.remove();
  typingUsers.delete(user);
}

function showTyping(user) {
  if (!user) return;
  let t = typingUsers.get(user);
  if (t) {
    clearTimeout(t.timer);
  } else {
    const el = $("<div>")
      .addClass("typing-indicator")
      .text(`${user} 正在輸入...`)
      .appendTo("#chat-messages");
    t = { el, timer: null };
    typingUsers.set(user, t);
  }
  t.timer = setTimeout(() => {
    typingUsers.delete(user);
    t.el.fadeOut(200, () => t.el.remove()); // 舊版用箭頭函式取 this，元素從沒被真正移除
  }, 3000);
  scrollBottom();
}

// 後端已用 include_self=False 排除自己，這裡不再用名稱過濾（同名的別人也能正常顯示）
socket.on("typing", (d) => showTyping(d.username));

/* ===== 輸入框：自動長高 + 節流送出 typing ===== */
let typingThrottle = null;
$("#message-input").on("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
  if (!typingThrottle) {
    socket.emit("typing", { username });
    typingThrottle = setTimeout(() => (typingThrottle = null), 1000);
  }
});

/* ===== 改暱稱 ===== */
/**
 * 先 trim 再送，並等伺服器確認（ack）後才更新本地名稱，
 * 確保前後端記錄的名稱一定相同
 */
$("#change-name-btn").on("click", () => {
  const v = (prompt("輸入新名稱：", username) || "").trim();
  if (!v || v === username) return;
  socket.emit("change_username", { oldUsername: username, newUsername: v }, (res) => {
    if (res && res.ok) {
      setUsername(res.username);
    } else {
      addSystem(`改名失敗：${(res && res.message) || "伺服器沒有回應"}`);
    }
  });
});

/* ===== 載入歷史訊息 ===== */
fetch("/get_history")
  .then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  })
  .then((list) => list.forEach(renderServerMessage))
  .catch((e) => {
    console.warn("載入歷史失敗：", e);
    addSystem("載入歷史紀錄失敗");
  })
  .finally(() => {
    historyLoaded = true;
    pending.splice(0).forEach(renderServerMessage); // 補上載入期間收到的即時訊息
  });

/* ===== 清空歷史 ===== */
/**
 * 畫面清空交給 history_cleared 事件處理（所有人同步）；
 * 只有在 socket 沒連線、收不到事件時才在本地自己清
 */
$("#clear-btn").on("click", () => {
  if (!confirm("確定要清空聊天？")) return;
  fetch("/clear_history", { method: "POST" })
    .then((r) =>
      r.json().then((body) => {
        if (!r.ok) throw new Error(body.message || `HTTP ${r.status}`);
        if (!socket.connected) {
          $("#chat-messages").empty();
          seenIds.clear();
          addSystem("歷史紀錄已清除");
        }
      })
    )
    .catch((e) => alert("清除失敗：" + e.message));
});