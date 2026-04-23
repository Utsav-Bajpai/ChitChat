const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json"); // ← your downloaded key

// ── Init Firebase Admin ──
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static("public"));

// In-memory: online presence only (ephemeral by nature)
const onlineUsers = new Map(); // socketId → { userId, username }

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function getConversationId(userA, userB) {
  return [userA, userB].sort().join("_");
}

// Middleware: verify Firebase ID token on REST calls
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided." });
  }
  const token = authHeader.split("Bearer ")[1];
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
}

// ─────────────────────────────────────────────
// REST ENDPOINTS
// ─────────────────────────────────────────────

// Called from register.html after Firebase Auth creates the user
app.post("/api/user/save", verifyToken, async (req, res) => {
  const { username } = req.body;
  const { uid, email } = req.user;

  if (!username || !username.trim()) {
    return res.status(400).json({ error: "Username is required." });
  }

  try {
    await db.collection("users").doc(uid).set({
      uid,
      username: username.trim(),
      email: email || null,
      avatar: username.trim().slice(0, 2).toUpperCase(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.status(201).json({ success: true });
  } catch (err) {
    console.error("Save user error:", err);
    res.status(500).json({ error: "Could not save user profile." });
  }
});

// Get all users except self (for sidebar)
app.get("/api/users", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("users").get();
    const users = snapshot.docs
      .map(doc => doc.data())
      .filter(u => u.uid !== req.user.uid)
      .map(u => ({
        id: u.uid,
        username: u.username,
        avatar: u.avatar,
        online: [...onlineUsers.values()].some(o => o.userId === u.uid)
      }));

    res.json(users);
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ error: "Could not fetch users." });
  }
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("🔌 Socket connected:", socket.id);

  // User joins — verify their Firebase token first
  socket.on("user_join", async ({ userId, username, token }) => {
    try {
      await admin.auth().verifyIdToken(token);
    } catch {
      console.warn("❌ Invalid token — disconnecting socket.");
      socket.disconnect();
      return;
    }

    onlineUsers.set(socket.id, { userId, username });
    socket.userId = userId;
    socket.username = username;

    socket.broadcast.emit("user_status_changed", { userId, online: true });
    console.log(`👤 ${username} joined (${userId})`);
  });

  // Load message history from Firestore
  socket.on("load_conversation", async ({ withUserId }) => {
    const convId = getConversationId(socket.userId, withUserId);
    try {
      const snapshot = await db.collection("messages")
        .where("conversationId", "==", convId)
        .orderBy("time", "asc")
        .limit(100)
        .get();

      const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      socket.emit("conversation_history", { withUserId, messages: history });
    } catch (err) {
      console.error("Load conversation error:", err);
      socket.emit("conversation_history", { withUserId, messages: [] });
    }
  });

  // Send a private message → save to Firestore
  socket.on("send_message", async ({ toUserId, text }) => {
    if (!text || !text.trim()) return;

    const convId = getConversationId(socket.userId, toUserId);
    const msg = {
      conversationId: convId,
      fromUserId: socket.userId,
      toUserId,
      senderName: socket.username,
      text: text.trim(),
      time: new Date().toISOString(),
      edited: false
    };

    try {
      const ref = await db.collection("messages").add(msg);
      const saved = { id: ref.id, ...msg };

      // Deliver to recipient if online
      const recipientEntry = [...onlineUsers.entries()]
        .find(([, u]) => u.userId === toUserId);
      if (recipientEntry) {
        io.to(recipientEntry[0]).emit("receive_message", saved);
      }

      // Confirm to sender
      socket.emit("message_sent", saved);
    } catch (err) {
      console.error("Send message error:", err);
    }
  });

  // Edit a message in Firestore
  socket.on("edit_message", async ({ messageId, newText, withUserId }) => {
    if (!newText || !newText.trim()) return;

    try {
      const ref = db.collection("messages").doc(messageId);
      const doc = await ref.get();

      if (!doc.exists || doc.data().fromUserId !== socket.userId) return;

      await ref.update({
        text: newText.trim(),
        edited: true,
        editedAt: new Date().toISOString()
      });

      const updated = { id: messageId, ...doc.data(), text: newText.trim(), edited: true };

      socket.emit("message_edited", updated);

      const recipientEntry = [...onlineUsers.entries()]
        .find(([, u]) => u.userId === withUserId);
      if (recipientEntry) {
        io.to(recipientEntry[0]).emit("message_edited", updated);
      }
    } catch (err) {
      console.error("Edit message error:", err);
    }
  });

  // Delete a message from Firestore
  socket.on("delete_message", async ({ messageId, withUserId }) => {
    try {
      const ref = db.collection("messages").doc(messageId);
      const doc = await ref.get();

      if (!doc.exists || doc.data().fromUserId !== socket.userId) return;

      await ref.delete();

      socket.emit("message_deleted", { messageId, withUserId });

      const recipientEntry = [...onlineUsers.entries()]
        .find(([, u]) => u.userId === withUserId);
      if (recipientEntry) {
        io.to(recipientEntry[0]).emit("message_deleted", { messageId, withUserId });
      }
    } catch (err) {
      console.error("Delete message error:", err);
    }
  });

  // Typing indicator
  socket.on("typing", ({ toUserId, isTyping }) => {
    const recipientEntry = [...onlineUsers.entries()]
      .find(([, u]) => u.userId === toUserId);
    if (recipientEntry) {
      io.to(recipientEntry[0]).emit("user_typing", {
        fromUserId: socket.userId,
        isTyping
      });
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    const user = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);

    if (user) {
      const stillOnline = [...onlineUsers.values()].some(u => u.userId === user.userId);
      if (!stillOnline) {
        io.emit("user_status_changed", { userId: user.userId, online: false });
        console.log(`👋 ${user.username} went offline`);
      }
    }
  });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});