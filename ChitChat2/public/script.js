/**
 * ChitChat — Frontend Script
 * Handles: Auth guard, Socket.IO, UI rendering, CRUD
 */

// ─────────────────────────────────────────────
// AUTH GUARD — Redirect to login if not logged in
// ─────────────────────────────────────────────
const session = JSON.parse(localStorage.getItem("chitchat_session") || "null");

if (!session || !session.user) {
  window.location.href = "login.html";
  throw new Error("Not authenticated");
}

const ME = session.user; // { id, username, avatar }

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let currentChatUserId = null;    // Who we're chatting with
let currentChatName   = "";
let allUsers          = [];       // Full user list from server
let unreadCounts      = {};       // { userId: count }
let typingTimer       = null;
let contextTarget     = null;     // { messageId, isEditing }

// Conversation cache: { userId: [messages] }
const convCache = {};

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const userListEl       = document.getElementById("userList");
const messagesArea     = document.getElementById("messagesArea");
const msgInput         = document.getElementById("msgInput");
const sendBtn          = document.getElementById("sendBtn");
const chatView         = document.getElementById("chatView");
const welcomeScreen    = document.getElementById("welcomeScreen");
const chatName         = document.getElementById("chatName");
const chatAvatar       = document.getElementById("chatAvatar");
const chatStatus       = document.getElementById("chatStatus");
const typingIndicator  = document.getElementById("typingIndicator");
const typingName       = document.getElementById("typingName");
const messagesLoader   = document.getElementById("messagesLoader");
const contextMenu      = document.getElementById("contextMenu");
const searchInput      = document.getElementById("searchInput");
const myAvatar         = document.getElementById("myAvatar");
const myUsernameEl     = document.getElementById("myUsername");
const sidebar          = document.getElementById("sidebar");
const overlay          = document.getElementById("overlay");
const fabMenu          = document.getElementById("fabMenu");

// ─────────────────────────────────────────────
// INIT UI
// ─────────────────────────────────────────────
myAvatar.textContent = ME.avatar;
myUsernameEl.textContent = ME.username;
document.getElementById("welcomeHint").textContent = `Signed in as ${ME.username}`;

// ─────────────────────────────────────────────
// SOCKET.IO CONNECTION
// ─────────────────────────────────────────────
const socket = io();

socket.on("connect", () => {
  console.log("✅ Socket connected:", socket.id);
  socket.emit("user_join", { userId: ME.id, username: ME.username });
});

socket.on("disconnect", () => {
  console.log("❌ Socket disconnected");
});

// ─────────────────────────────────────────────
// SOCKET EVENTS — USERS
// ─────────────────────────────────────────────

/** Receive full user list on join */
socket.on("users_list", (users) => {
  allUsers = users;
  renderUserList(users);
});

/** A user came online or went offline */
socket.on("user_status_changed", ({ userId, online }) => {
  const idx = allUsers.findIndex(u => u.id === userId);
  if (idx !== -1) {
    allUsers[idx].online = online;
  } else if (online) {
    // New user — we may not have them yet; re-request would be ideal
    // For now just mark them for render if found
  }

  renderUserList(allUsers);

  // Update chat header if this is the active chat
  if (userId === currentChatUserId) {
    updateChatHeader(userId);
  }
});

// ─────────────────────────────────────────────
// SOCKET EVENTS — MESSAGES
// ─────────────────────────────────────────────

/** Server echoes our sent message back */
socket.on("message_sent", (msg) => {
  addToCache(msg.toUserId, msg);
  if (currentChatUserId === msg.toUserId) {
    appendMessage(msg);
  }
});

/** We receive a new message from someone */
socket.on("receive_message", (msg) => {
  addToCache(msg.fromUserId, msg);

  if (currentChatUserId === msg.fromUserId) {
    appendMessage(msg);
  } else {
    // Increment unread badge
    unreadCounts[msg.fromUserId] = (unreadCounts[msg.fromUserId] || 0) + 1;
    renderUserList(allUsers);
  }
});

/** Conversation history loaded */
socket.on("conversation_history", ({ withUserId, messages }) => {
  convCache[withUserId] = messages;
  messagesLoader.style.display = "none";
  renderConversation(withUserId);
});

/** A message was edited */
socket.on("message_edited", (msg) => {
  // Update cache
  const convId = getConvPartnerId(msg);
  if (convCache[convId]) {
    const idx = convCache[convId].findIndex(m => m.id === msg.id);
    if (idx !== -1) convCache[convId][idx] = msg;
  }

  // Update DOM if visible
  const el = document.getElementById(`msg-${msg.id}`);
  if (el) {
    const textEl = el.querySelector(".bubble-text");
    const editedEl = el.querySelector(".bubble-edited");
    if (textEl) textEl.textContent = msg.text;
    if (editedEl) editedEl.textContent = "edited";
  }
});

/** A message was deleted */
socket.on("message_deleted", ({ messageId, withUserId }) => {
  const convId = withUserId === ME.id
    ? (currentChatUserId || withUserId)
    : withUserId;

  // Remove from cache
  if (convCache[convId]) {
    convCache[convId] = convCache[convId].filter(m => m.id !== messageId);
  }

  // Remove from DOM
  const el = document.getElementById(`msg-${messageId}`);
  if (el) {
    el.style.animation = "none";
    el.style.opacity = "0";
    el.style.transform = "scale(0.95)";
    el.style.transition = "all 0.2s ease";
    setTimeout(() => el.remove(), 200);
  }
});

/** Typing indicator */
socket.on("user_typing", ({ fromUserId, isTyping }) => {
  if (fromUserId !== currentChatUserId) return;

  if (isTyping) {
    typingName.textContent = currentChatName;
    typingIndicator.style.display = "flex";
  } else {
    typingIndicator.style.display = "none";
  }
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getConvPartnerId(msg) {
  return msg.fromUserId === ME.id ? msg.toUserId : msg.fromUserId;
}

function addToCache(partnerId, msg) {
  if (!convCache[partnerId]) convCache[partnerId] = [];
  // Avoid duplicates
  if (!convCache[partnerId].find(m => m.id === msg.id)) {
    convCache[partnerId].push(msg);
  }
}

function formatTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "long" });
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────
// RENDER — USER LIST
// ─────────────────────────────────────────────

function renderUserList(users) {
  const query = searchInput.value.toLowerCase();
  const filtered = users.filter(u => u.username.toLowerCase().includes(query));

  if (filtered.length === 0) {
    userListEl.innerHTML = `
      <div class="user-list-empty">
        <div class="empty-icon">👥</div>
        <p>${query ? "No results found." : "No other users online yet."}</p>
        ${!query ? '<p class="empty-hint">Open a second tab and register another user!</p>' : ""}
      </div>`;
    return;
  }

  userListEl.innerHTML = "";

  filtered.forEach((user, i) => {
    const item = document.createElement("div");
    item.className = "user-item" + (user.id === currentChatUserId ? " active" : "");
    item.style.animationDelay = `${i * 40}ms`;

    const dotColor = user.online ? "var(--online)" : "var(--offline)";
    const unread = unreadCounts[user.id] || 0;

    item.innerHTML = `
      <div class="user-avatar">
        ${user.avatar}
        <span class="user-avatar-dot" style="background:${dotColor}"></span>
      </div>
      <div class="user-meta">
        <div class="user-name">${escapeHtml(user.username)}</div>
        <div class="user-preview">${user.online ? "Online" : "Offline"}</div>
      </div>
      ${unread ? `<div class="unread-badge">${unread}</div>` : ""}
    `;

    item.addEventListener("click", () => openChat(user));
    userListEl.appendChild(item);
  });
}

// ─────────────────────────────────────────────
// OPEN A CHAT
// ─────────────────────────────────────────────

function openChat(user) {
  currentChatUserId = user.id;
  currentChatName = user.username;

  // Clear unread
  unreadCounts[user.id] = 0;
  renderUserList(allUsers);

  // Update header
  updateChatHeader(user.id);

  // Show chat view
  welcomeScreen.style.display = "none";
  chatView.style.display = "flex";

  // Close sidebar on mobile
  closeSidebar();

  // Load messages
  messagesArea.innerHTML = "";
  messagesLoader.style.display = "block";
  messagesArea.appendChild(messagesLoader);

  if (convCache[user.id]) {
    // Use cache
    messagesLoader.style.display = "none";
    renderConversation(user.id);
  } else {
    socket.emit("load_conversation", { withUserId: user.id });
  }

  msgInput.focus();
}

function updateChatHeader(userId) {
  const user = allUsers.find(u => u.id === userId);
  chatName.textContent = currentChatName;
  chatAvatar.textContent = user?.avatar || currentChatName.slice(0, 2).toUpperCase();

  const online = user?.online ?? false;
  chatStatus.innerHTML = `
    <span class="status-dot" style="background:${online ? "var(--online)" : "var(--offline)"}"></span>
    <span class="status-label">${online ? "Online" : "Offline"}</span>
  `;
}

// ─────────────────────────────────────────────
// RENDER CONVERSATION
// ─────────────────────────────────────────────

function renderConversation(partnerId) {
  const msgs = convCache[partnerId] || [];
  messagesArea.innerHTML = "";

  if (msgs.length === 0) {
    messagesArea.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-dim);font-size:0.82rem;">
        No messages yet. Say hello! 👋
      </div>`;
    return;
  }

  let lastDate = null;

  msgs.forEach(msg => {
    // Date divider
    const dateStr = formatDate(msg.time);
    if (dateStr !== lastDate) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.innerHTML = `<span>${dateStr}</span>`;
      messagesArea.appendChild(divider);
      lastDate = dateStr;
    }

    appendMessage(msg, false); // false = don't scroll yet
  });

  scrollBottom();
}

// ─────────────────────────────────────────────
// APPEND A SINGLE MESSAGE
// ─────────────────────────────────────────────

function appendMessage(msg, doScroll = true) {
  const isMine = msg.fromUserId === ME.id;

  const row = document.createElement("div");
  row.className = `msg-row ${isMine ? "mine" : "theirs"}`;
  row.id = `msg-${msg.id}`;

  const actions = isMine ? `
    <div class="msg-actions">
      <button class="msg-action-btn" onclick="startEdit('${msg.id}', '${currentChatUserId}')">✏️</button>
      <button class="msg-action-btn" onclick="confirmDelete('${msg.id}', '${currentChatUserId}')">🗑</button>
    </div>
  ` : "";

  row.innerHTML = `
    ${actions}
    <div class="bubble ${isMine ? "mine" : "theirs"}">
      <span class="bubble-text">${escapeHtml(msg.text)}</span>
      <div class="bubble-meta">
        ${msg.edited ? '<span class="bubble-edited">edited</span>' : ""}
        <span class="bubble-time">${formatTime(msg.time)}</span>
      </div>
    </div>
  `;

  // Long press / right-click on mobile
  row.addEventListener("contextmenu", (e) => {
    if (isMine) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, msg.id);
    }
  });

  messagesArea.appendChild(row);

  if (doScroll) scrollBottom();
}

function scrollBottom() {
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

// ─────────────────────────────────────────────
// SEND MESSAGE
// ─────────────────────────────────────────────

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !currentChatUserId) return;

  socket.emit("send_message", {
    toUserId: currentChatUserId,
    text
  });

  msgInput.value = "";
  clearTyping();
}

sendBtn.addEventListener("click", sendMessage);

msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ─────────────────────────────────────────────
// TYPING INDICATOR
// ─────────────────────────────────────────────

let isTyping = false;

msgInput.addEventListener("input", () => {
  if (!currentChatUserId) return;

  if (!isTyping) {
    isTyping = true;
    socket.emit("typing", { toUserId: currentChatUserId, isTyping: true });
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(clearTyping, 1500);
});

function clearTyping() {
  if (isTyping && currentChatUserId) {
    isTyping = false;
    socket.emit("typing", { toUserId: currentChatUserId, isTyping: false });
  }
}

// ─────────────────────────────────────────────
// EDIT MESSAGE
// ─────────────────────────────────────────────

function startEdit(messageId, withUserId) {
  const msgEl = document.getElementById(`msg-${messageId}`);
  const textEl = msgEl?.querySelector(".bubble-text");
  if (!textEl) return;

  const currentText = textEl.textContent;
  const newText = prompt("Edit your message:", currentText);

  if (!newText || newText.trim() === currentText) return;

  socket.emit("edit_message", {
    messageId,
    newText: newText.trim(),
    withUserId
  });
}

// ─────────────────────────────────────────────
// DELETE MESSAGE
// ─────────────────────────────────────────────

function confirmDelete(messageId, withUserId) {
  if (!confirm("Delete this message?")) return;

  socket.emit("delete_message", { messageId, withUserId });
}

// ─────────────────────────────────────────────
// CONTEXT MENU (right-click)
// ─────────────────────────────────────────────

function showContextMenu(x, y, messageId) {
  contextTarget = messageId;

  contextMenu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  contextMenu.style.top  = `${Math.min(y, window.innerHeight - 100)}px`;
  contextMenu.style.display = "block";
}

document.getElementById("ctxEdit").addEventListener("click", () => {
  if (contextTarget) startEdit(contextTarget, currentChatUserId);
  contextMenu.style.display = "none";
});

document.getElementById("ctxDelete").addEventListener("click", () => {
  if (contextTarget) confirmDelete(contextTarget, currentChatUserId);
  contextMenu.style.display = "none";
});

document.addEventListener("click", () => {
  contextMenu.style.display = "none";
});

// ─────────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────────

document.getElementById("logoutBtn").addEventListener("click", () => {
  if (confirm("Log out of ChitChat?")) {
    localStorage.removeItem("chitchat_session");
    window.location.href = "login.html";
  }
});

// ─────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────

searchInput.addEventListener("input", () => {
  renderUserList(allUsers);
});

// ─────────────────────────────────────────────
// MOBILE SIDEBAR
// ─────────────────────────────────────────────

function openSidebar() {
  sidebar.classList.add("open");
  overlay.classList.add("show");
  fabMenu.classList.add("hidden");
}

function closeSidebar() {
  sidebar.classList.remove("open");
  overlay.classList.remove("show");
  fabMenu.classList.remove("hidden");
}

// ─────────────────────────────────────────────
// SECURITY — Escape HTML to prevent XSS
// ─────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
