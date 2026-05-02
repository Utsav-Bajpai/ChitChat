/**
 * ChitChat — Frontend Script
 * Handles: Auth guard, Socket.IO, UI rendering, CRUD
 */

// ─────────────────────────────────────────────
// AUTH GUARD
// ─────────────────────────────────────────────
const session = JSON.parse(localStorage.getItem("chitchat_session") || "null");
if (!session || !session.user || !session.token) {
  window.location.href = "login.html";
  throw new Error("Not authenticated");
}

const ME = session.user; // { id, username, avatar }

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let currentChatUserId = null;
let currentChatName   = "";
let allUsers          = [];
let unreadCounts      = {};
let typingTimer       = null;
let isTyping          = false;
let contextTarget     = null;

// ── Photo Upload State ──
let currentPhoto      = null; // { file, preview }

const convCache = {}; // { userId: [messages] }

// ─────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────
const userListEl      = document.getElementById("userList");
const messagesArea    = document.getElementById("messagesArea");
const msgInput        = document.getElementById("msgInput");
const sendBtn         = document.getElementById("sendBtn");
const chatView        = document.getElementById("chatView");
const welcomeScreen   = document.getElementById("welcomeScreen");
const chatName        = document.getElementById("chatName");
const chatAvatar      = document.getElementById("chatAvatar");
const chatStatus      = document.getElementById("chatStatus");
const typingIndicator = document.getElementById("typingIndicator");
const typingName      = document.getElementById("typingName");
const messagesLoader  = document.getElementById("messagesLoader");
const contextMenu     = document.getElementById("contextMenu");
const searchInput     = document.getElementById("searchInput");
const myAvatar        = document.getElementById("myAvatar");
const myUsernameEl    = document.getElementById("myUsername");
const sidebar         = document.getElementById("sidebar");
const overlay         = document.getElementById("overlay");
const fabMenu         = document.getElementById("fabMenu");

// ── Photo Upload Elements ──
const photoInput      = document.getElementById("photoInput");
const photoBtn        = document.getElementById("photoBtn");
const photoPreview    = document.getElementById("photoPreview");
const photoPreviewImg = document.getElementById("photoPreviewImg");
const photoRemoveBtn  = document.getElementById("photoRemoveBtn");

// ─────────────────────────────────────────────
// INIT UI
// ─────────────────────────────────────────────
myAvatar.textContent = ME.avatar;
myUsernameEl.textContent = ME.username;

const welcomeHint = document.getElementById("welcomeHint");
if (welcomeHint) welcomeHint.textContent = `Signed in as ${ME.username}`;

// ─────────────────────────────────────────────
// PHOTO UPLOAD HANDLERS
// ─────────────────────────────────────────────

photoBtn.addEventListener("click", () => {
  photoInput.click();
});

photoInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  // Validate file size (max 5MB)
  const MAX_SIZE = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE) {
    alert("Photo must be smaller than 5MB");
    photoInput.value = "";
    return;
  }

  // Validate file type
  const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!validTypes.includes(file.type)) {
    alert("Only JPG, PNG, WebP, and GIF images are allowed");
    photoInput.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = (event) => {
    const dataUrl = event.target.result;
    currentPhoto = { file, preview: dataUrl };
    photoPreviewImg.src = dataUrl;
    photoPreview.style.display = "flex";
    photoBtn.classList.add("active");
  };
  reader.readAsDataURL(file);
});

photoRemoveBtn.addEventListener("click", () => {
  currentPhoto = null;
  photoInput.value = "";
  photoPreview.style.display = "none";
  photoBtn.classList.remove("active");
});

// ─────────────────────────────────────────────
// LIGHTBOX (Image Preview)
// ─────────────────────────────────────────────

function createLightbox() {
  const lightbox = document.createElement("div");
  lightbox.className = "lightbox";
  lightbox.id = "lightbox";
  lightbox.innerHTML = `
    <div class="lightbox-content">
      <img id="lightboxImage" class="lightbox-image" src="" alt="fullscreen image" />
      <button class="lightbox-close" onclick="closeLightbox()">✕</button>
    </div>
  `;
  document.body.appendChild(lightbox);
}

function openLightbox(imageSrc) {
  let lightbox = document.getElementById("lightbox");
  if (!lightbox) createLightbox();
  lightbox = document.getElementById("lightbox");
  const img = lightbox.querySelector("#lightboxImage");
  img.src = imageSrc;
  lightbox.classList.add("active");
}

function closeLightbox() {
  const lightbox = document.getElementById("lightbox");
  if (lightbox) lightbox.classList.remove("active");
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLightbox();
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
const socket = io();

socket.on("connect", () => {
  console.log("✅ Socket connected:", socket.id);
  // Pass Firebase token so server can verify identity
  socket.emit("user_join", {
    userId:   ME.id,
    username: ME.username,
    token:    session.token
  });

  // Load user list from server (Firestore)
  loadUsers();
});

socket.on("disconnect", () => {
  console.warn("❌ Socket disconnected");
});

// ─────────────────────────────────────────────
// LOAD USERS FROM SERVER (REST, not socket)
// ─────────────────────────────────────────────
async function loadUsers() {
  try {
    const res = await fetch("/api/users", {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    if (!res.ok) {
      if (res.status === 401) {
        // Token expired — send back to login
        localStorage.removeItem("chitchat_session");
        window.location.href = "login.html";
        return;
      }
      throw new Error("Failed to load users");
    }
    const users = await res.json();
    allUsers = users;
    renderUserList(users);
  } catch (err) {
    console.error("loadUsers error:", err);
  }
}

// ─────────────────────────────────────────────
// SOCKET EVENTS — USERS
// ─────────────────────────────────────────────

socket.on("user_status_changed", ({ userId, online }) => {
  const u = allUsers.find(u => u.id === userId);
  if (u) u.online = online;
  renderUserList(allUsers);
  if (userId === currentChatUserId) updateChatHeader(userId);
});

// ─────────────────────────────────────────────
// SOCKET EVENTS — MESSAGES
// ─────────────────────────────────────────────

socket.on("message_sent", (msg) => {
  addToCache(msg.toUserId, msg);
  if (currentChatUserId === msg.toUserId) appendMessage(msg);
});

socket.on("receive_message", (msg) => {
  addToCache(msg.fromUserId, msg);
  if (currentChatUserId === msg.fromUserId) {
    appendMessage(msg);
  } else {
    unreadCounts[msg.fromUserId] = (unreadCounts[msg.fromUserId] || 0) + 1;
    renderUserList(allUsers);
  }
});

socket.on("conversation_history", ({ withUserId, messages }) => {
  convCache[withUserId] = messages;
  messagesLoader.style.display = "none";
  renderConversation(withUserId);
});

socket.on("message_edited", (msg) => {
  const partnerId = msg.fromUserId === ME.id ? msg.toUserId : msg.fromUserId;
  if (convCache[partnerId]) {
    const idx = convCache[partnerId].findIndex(m => m.id === msg.id);
    if (idx !== -1) convCache[partnerId][idx] = msg;
  }

  const el = document.getElementById(`msg-${msg.id}`);
  if (el) {
    const textEl   = el.querySelector(".bubble-text");
    const editedEl = el.querySelector(".bubble-edited");
    if (textEl)   textEl.textContent = msg.text;
    if (editedEl) editedEl.textContent = "edited";
    else {
      // Add edited label if not present
      const meta = el.querySelector(".bubble-meta");
      if (meta) {
        const span = document.createElement("span");
        span.className = "bubble-edited";
        span.textContent = "edited";
        meta.prepend(span);
      }
    }
  }
});

socket.on("message_deleted", ({ messageId }) => {
  // Remove from all caches
  for (const key of Object.keys(convCache)) {
    convCache[key] = convCache[key].filter(m => m.id !== messageId);
  }

  const el = document.getElementById(`msg-${messageId}`);
  if (el) {
    el.style.transition = "all 0.2s ease";
    el.style.opacity    = "0";
    el.style.transform  = "scale(0.95)";
    setTimeout(() => el.remove(), 200);
  }
});

socket.on("user_typing", ({ fromUserId, isTyping }) => {
  if (fromUserId !== currentChatUserId) return;
  typingName.textContent = currentChatName;
  typingIndicator.style.display = isTyping ? "flex" : "none";
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function addToCache(partnerId, msg) {
  if (!convCache[partnerId]) convCache[partnerId] = [];
  if (!convCache[partnerId].find(m => m.id === msg.id)) {
    convCache[partnerId].push(msg);
  }
}

function formatTime(isoString) {
  try {
    return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function formatDate(isoString) {
  try {
    const d = new Date(isoString);
    const today     = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString())     return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "long" });
  } catch { return ""; }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─────────────────────────────────────────────
// RENDER USER LIST
// ─────────────────────────────────────────────

function renderUserList(users) {
  const query    = searchInput.value.toLowerCase();
  const filtered = users.filter(u => u.username.toLowerCase().includes(query));

  if (filtered.length === 0) {
    userListEl.innerHTML = `
      <div class="user-list-empty">
        <div class="empty-icon">👥</div>
        <p>${query ? "No results found." : "No other users yet."}</p>
        ${!query ? '<p class="empty-hint">Register another account in a new tab!</p>' : ""}
      </div>`;
    return;
  }

  userListEl.innerHTML = "";
  filtered.forEach((user, i) => {
    const item = document.createElement("div");
    item.className = `user-item${user.id === currentChatUserId ? " active" : ""}`;
    item.style.animationDelay = `${i * 40}ms`;

    const dotColor = user.online ? "var(--online)" : "var(--offline)";
    const unread   = unreadCounts[user.id] || 0;

    item.innerHTML = `
      <div class="user-avatar">
        ${escapeHtml(user.avatar)}
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
  currentChatName   = user.username;

  unreadCounts[user.id] = 0;
  renderUserList(allUsers);
  updateChatHeader(user.id);

  welcomeScreen.style.display = "none";
  chatView.style.display = "flex";
  closeSidebar();

  messagesArea.innerHTML = "";
  messagesLoader.style.display = "block";
  messagesArea.appendChild(messagesLoader);

  if (convCache[user.id]) {
    messagesLoader.style.display = "none";
    renderConversation(user.id);
  } else {
    socket.emit("load_conversation", { withUserId: user.id });
  }

  msgInput.focus();
}

function updateChatHeader(userId) {
  const user = allUsers.find(u => u.id === userId);
  chatName.textContent   = currentChatName;
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
    const dateStr = formatDate(msg.time);
    if (dateStr !== lastDate) {
      const divider = document.createElement("div");
      divider.className = "date-divider";
      divider.innerHTML = `<span>${dateStr}</span>`;
      messagesArea.appendChild(divider);
      lastDate = dateStr;
    }
    appendMessage(msg, false);
  });

  scrollBottom();
}

// ─────────────────────────────────────────────
// APPEND A MESSAGE
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

  // Check if message has a photo
  const hasPhoto = msg.photoData || msg.photoUrl;
  const imageHtml = hasPhoto ? `
    <img 
      src="${msg.photoData || msg.photoUrl}" 
      class="bubble-image" 
      alt="message image"
      onclick="openLightbox(this.src)"
    />
  ` : "";

  row.innerHTML = `
    ${actions}
    <div class="bubble ${isMine ? "mine" : "theirs"}">
      ${imageHtml}
      <span class="bubble-text">${escapeHtml(msg.text)}</span>
      <div class="bubble-meta">
        ${msg.edited ? '<span class="bubble-edited">edited</span>' : ""}
        <span class="bubble-time">${formatTime(msg.time)}</span>
      </div>
    </div>
  `;

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
  const hasPhoto = currentPhoto !== null;

  if (!text && !hasPhoto) return;
  if (!currentChatUserId) return;

  if (hasPhoto) {
    // Send photo with optional caption
    socket.emit("send_message", { 
      toUserId: currentChatUserId, 
      text: text || "📸 Photo",
      photoData: currentPhoto.preview
    });
    currentPhoto = null;
    photoInput.value = "";
    photoPreview.style.display = "none";
    photoBtn.classList.remove("active");
  } else {
    // Send text-only message
    socket.emit("send_message", { toUserId: currentChatUserId, text });
  }

  msgInput.value = "";
  clearTypingState();
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

msgInput.addEventListener("input", () => {
  if (!currentChatUserId) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit("typing", { toUserId: currentChatUserId, isTyping: true });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(clearTypingState, 1500);
});

function clearTypingState() {
  if (isTyping && currentChatUserId) {
    isTyping = false;
    socket.emit("typing", { toUserId: currentChatUserId, isTyping: false });
  }
}

// ─────────────────────────────────────────────
// EDIT / DELETE
// ─────────────────────────────────────────────

function startEdit(messageId, withUserId) {
  const msgEl  = document.getElementById(`msg-${messageId}`);
  const textEl = msgEl?.querySelector(".bubble-text");
  if (!textEl) return;

  const newText = prompt("Edit your message:", textEl.textContent);
  if (!newText || newText.trim() === textEl.textContent) return;

  socket.emit("edit_message", { messageId, newText: newText.trim(), withUserId });
}

function confirmDelete(messageId, withUserId) {
  if (!confirm("Delete this message?")) return;
  socket.emit("delete_message", { messageId, withUserId });
}

// ─────────────────────────────────────────────
// CONTEXT MENU
// ─────────────────────────────────────────────

function showContextMenu(x, y, messageId) {
  contextTarget = messageId;
  contextMenu.style.left    = `${Math.min(x, window.innerWidth  - 160)}px`;
  contextMenu.style.top     = `${Math.min(y, window.innerHeight - 100)}px`;
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

document.addEventListener("click", () => { contextMenu.style.display = "none"; });

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

searchInput.addEventListener("input", () => renderUserList(allUsers));

// ─────────────────────────────────────────────
// MOBILE SIDEBAR
// ─────────────────────────────────────────────

function openSidebar() {
  sidebar.classList.add("open");
  overlay.classList.add("show");
  if (fabMenu) fabMenu.classList.add("hidden");
}

function closeSidebar() {
  sidebar.classList.remove("open");
  overlay.classList.remove("show");
  if (fabMenu) fabMenu.classList.remove("hidden");
}
