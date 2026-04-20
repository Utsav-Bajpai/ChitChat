
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid"); // npm install uuid

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static("public"));



const users = new Map();        // userId → user object
const onlineUsers = new Map();  // socketId → userId
const messages = new Map();     // conversationId → [messages]


/**
 Get or create a conversation ID for two users.
 Sorted to ensure A↔B and B↔A produce same key.
 */
function getConversationId(userA, userB) {
  return [userA, userB].sort().join("_");
}


//  Find a user by email or phone.
//  Replace with: User.findOne({ $or: [{ email }, { phone }] })

function findUserByCredential(credential) {
  for (const user of users.values()) {
    if (user.email === credential || user.phone === credential) {
      return user;
    }
  }
  return null;
}


//  Get all users except the current one (for sidebar).
//  Replace with: User.find({ _id: { $ne: userId } })

function getOtherUsers(currentUserId) {
  return Array.from(users.values())
    .filter(u => u.id !== currentUserId)
    .map(u => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      online: [...onlineUsers.values()].includes(u.id)
    }));
}

/** REGISTER */
app.post("/api/register", (req, res) => {
  const { username, email, phone, password } = req.body;

  // Validation
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required." });
  }
  if (!email && !phone) {
    return res.status(400).json({ error: "Email or phone is required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email format." });
  }

  // Check duplicate
  const credential = email || phone;
  if (findUserByCredential(credential)) {
    return res.status(409).json({ error: "User with this email/phone already exists." });
  }

  // Create user
  // Replace with: new User({ ... }).save()
  const newUser = {
    id: uuidv4(),
    username: username.trim(),
    email: email || null,
    phone: phone || null,
    password, //Replace with: bcrypt.hash(password, 10)
    avatar: username.trim().slice(0, 2).toUpperCase(),
    createdAt: new Date().toISOString()
  };

  users.set(newUser.id, newUser);
  console.log(` Registered: ${newUser.username} (${newUser.id})`);

  res.status(201).json({
    success: true,
    user: { id: newUser.id, username: newUser.username, avatar: newUser.avatar }
  });
});

/** LOGIN */
app.post("/api/login", (req, res) => {
  const { credential, password } = req.body;

  if (!credential || !password) {
    return res.status(400).json({ error: "All fields are required." });
  }

  // Replace with: User.findOne({ $or: [{ email: credential }, { phone: credential }] })
  const user = findUserByCredential(credential);

  if (!user || user.password !== password) {
    // Replace password check with: bcrypt.compare(password, user.password)
    return res.status(401).json({ error: "Invalid credentials." });
  }

  // Replace with: JWT token — jwt.sign({ userId: user.id }, SECRET, { expiresIn: '7d' })
  const sessionToken = `${user.id}_${Date.now()}`;

  console.log(` Login: ${user.username}`);

  res.json({
    success: true,
    token: sessionToken,
    user: { id: user.id, username: user.username, avatar: user.avatar }
  });
});

// SOCKET.IO — Real-Time Events

io.on("connection", (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // ── USER JOINS ──
  socket.on("user_join", ({ userId, username }) => {
    onlineUsers.set(socket.id, userId);
    socket.userId = userId;
    socket.username = username;

    // Notify all others this user is online
    socket.broadcast.emit("user_status_changed", { userId, online: true });

    // Send the joining user a full list of all users + their status
    const allUsers = getOtherUsers(userId);
    socket.emit("users_list", allUsers);

    console.log(`👤 ${username} joined (${userId})`);
  });

  // ── LOAD CONVERSATION ──
  socket.on("load_conversation", ({ withUserId }) => {
    const myId = socket.userId;
    const convId = getConversationId(myId, withUserId);

    // Replace with: Message.find({ conversationId: convId }).sort({ createdAt: 1 })
    const history = messages.get(convId) || [];
    socket.emit("conversation_history", { withUserId, messages: history });
  });

  // SEND MESSAGE (Private 1-to-1)
  socket.on("send_message", ({ toUserId, text }) => {
    if (!text || !text.trim()) return;

    const fromUserId = socket.userId;
    const convId = getConversationId(fromUserId, toUserId);

    const msg = {
      id: uuidv4(),
      conversationId: convId,
      fromUserId,
      toUserId,
      senderName: socket.username,
      text: text.trim(),
      time: new Date().toISOString(),
      edited: false
    };

    // Replace with: new Message(msg).save()
    if (!messages.has(convId)) messages.set(convId, []);
    messages.get(convId).push(msg);

    // Send to recipient (find their socket)
    const recipientSocketId = [...onlineUsers.entries()]
      .find(([, uid]) => uid === toUserId)?.[0];

    if (recipientSocketId) {
      io.to(recipientSocketId).emit("receive_message", msg);
    }

    // Echo back to sender
    socket.emit("message_sent", msg);
  });

  // EDIT MESSAGE
  socket.on("edit_message", ({ messageId, newText, withUserId }) => {
    const convId = getConversationId(socket.userId, withUserId);
    const history = messages.get(convId) || [];
    const msgIndex = history.findIndex(m => m.id === messageId);

    if (msgIndex === -1) return;
    if (history[msgIndex].fromUserId !== socket.userId) return; // Only own messages

    // Replace with: Message.findByIdAndUpdate(messageId, { text: newText, edited: true })
    history[msgIndex].text = newText;
    history[msgIndex].edited = true;
    history[msgIndex].editedAt = new Date().toISOString();

    const updated = history[msgIndex];

    // Notify both parties
    socket.emit("message_edited", updated);

    const recipientSocketId = [...onlineUsers.entries()]
      .find(([, uid]) => uid === withUserId)?.[0];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit("message_edited", updated);
    }
  });

  // ── DELETE MESSAGE ──
  socket.on("delete_message", ({ messageId, withUserId }) => {
    const convId = getConversationId(socket.userId, withUserId);
    const history = messages.get(convId) || [];
    const msgIndex = history.findIndex(m => m.id === messageId);

    if (msgIndex === -1) return;
    if (history[msgIndex].fromUserId !== socket.userId) return;

    // Replace with: Message.findByIdAndDelete(messageId)
    messages.set(convId, history.filter(m => m.id !== messageId));

    // Notify both parties
    socket.emit("message_deleted", { messageId, withUserId });

    const recipientSocketId = [...onlineUsers.entries()]
      .find(([, uid]) => uid === withUserId)?.[0];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit("message_deleted", { messageId, withUserId });
    }
  });

  // TYPING INDICATOR
  socket.on("typing", ({ toUserId, isTyping }) => {
    const recipientSocketId = [...onlineUsers.entries()]
      .find(([, uid]) => uid === toUserId)?.[0];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit("user_typing", {
        fromUserId: socket.userId,
        isTyping
      });
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    const userId = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);

    if (userId) {
      // Check if user has other open tabs
      const stillOnline = [...onlineUsers.values()].includes(userId);
      if (!stillOnline) {
        io.emit("user_status_changed", { userId, online: false });
        console.log(` ${socket.username || userId} went offline`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n ChitChat server running at http://localhost:${PORT}`);
  console.log(`📁 Serving static files from /public\n`);
});
