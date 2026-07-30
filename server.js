const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e7,
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(__dirname));
app.use(express.json());

// ===== PERSISTENT STORAGE =====
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log(`📂 Loaded ${Object.keys(data.users || {}).length} users`);
      return data;
    }
  } catch (e) { console.log('⚠️ Starting fresh'); }
  return { users: {}, friendships: {} };
}

function saveData() {
  try {
    const usersObj = {};
    for (const [id, user] of users) {
      usersObj[id] = { id: user.id, name: user.name, pin: user.pin, avatar: user.avatar };
    }
    const friendsObj = {};
    for (const [id, friends] of friendships) {
      friendsObj[id] = Array.from(friends);
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users: usersObj, friendships: friendsObj }, null, 2));
  } catch (e) { console.error('⚠️ Save error:', e.message); }
}

// ===== DATA =====
const stored = loadData();
const users = new Map();
const sockets = new Map();
const friendships = new Map();
const pins = new Map();

for (const [id, userData] of Object.entries(stored.users)) {
  users.set(id, { ...userData, socketId: null, online: false });
  pins.set(userData.pin, id);
}
for (const [id, friendIds] of Object.entries(stored.friendships || {})) {
  friendships.set(id, new Set(friendIds));
}

function generatePin() {
  let pin;
  do { pin = Math.floor(100000 + Math.random() * 900000).toString(); } while (pins.has(pin));
  return pin;
}

function getFriendsList(userId) {
  const friends = friendships.get(userId) || new Set();
  return Array.from(friends).map(fid => {
    const f = users.get(fid);
    return f ? { id: f.id, name: f.name, pin: f.pin, avatar: f.avatar, online: !!f.socketId } : null;
  }).filter(Boolean);
}

function notifyFriends(userId, isOnline) {
  const friends = friendships.get(userId) || new Set();
  const user = users.get(userId);
  if (!user) return;
  friends.forEach(fid => {
    const f = users.get(fid);
    if (f && f.socketId) {
      io.to(f.socketId).emit('friend-status', { friendId: userId, online: isOnline });
    }
  });
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // REGISTER
  socket.on('register', ({ name }) => {
    const userId = uuidv4();
    const pin = generatePin();
    const avatar = `https://api.dicebear.com/7.x/thumbs/svg?seed=${userId}`;
    const user = { id: userId, name: name || `User_${pin.slice(0,4)}`, pin, avatar, socketId: socket.id, online: true };
    users.set(userId, user);
    sockets.set(socket.id, userId);
    pins.set(pin, userId);
    friendships.set(userId, new Set());
    saveData();
    socket.emit('registered', { user });
    console.log(`Registered: ${user.name} PIN:${pin}`);
  });

  // LOGIN
  socket.on('login', ({ userId }) => {
    const user = users.get(userId);
    if (user) {
      if (user.socketId) sockets.delete(user.socketId);
      user.socketId = socket.id;
      user.online = true;
      sockets.set(socket.id, userId);
      socket.emit('registered', { user });
      socket.emit('friends-list', { friends: getFriendsList(userId) });
      notifyFriends(userId, true);
    } else {
      socket.emit('login-failed');
    }
  });

  // LOGIN BY PIN
  socket.on('login-pin', ({ pin }) => {
    const userId = pins.get(pin);
    if (!userId) { socket.emit('login-failed'); return; }
    const user = users.get(userId);
    if (user) {
      if (user.socketId) sockets.delete(user.socketId);
      user.socketId = socket.id;
      user.online = true;
      sockets.set(socket.id, userId);
      socket.emit('registered', { user });
      socket.emit('friends-list', { friends: getFriendsList(userId) });
      socket.emit('save-user', { user });
      notifyFriends(userId, true);
    }
  });

  // ADD FRIEND
  socket.on('add-friend', ({ pin }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const user = users.get(userId);
    if (!user) return;
    const friendUserId = pins.get(pin);
    if (!friendUserId) { socket.emit('error', { message: 'Invalid PIN!' }); return; }
    if (friendUserId === userId) { socket.emit('error', { message: "Can't add yourself!" }); return; }
    const uf = friendships.get(userId) || new Set();
    if (uf.has(friendUserId)) { socket.emit('error', { message: 'Already friends!' }); return; }
    uf.add(friendUserId);
    const ff = friendships.get(friendUserId) || new Set();
    ff.add(userId);
    friendships.set(userId, uf);
    friendships.set(friendUserId, ff);
    saveData();
    const friend = users.get(friendUserId);
    socket.emit('friend-added', { friend: { id: friend.id, name: friend.name, pin: friend.pin, avatar: friend.avatar, online: !!friend.socketId } });
    if (friend.socketId) {
      io.to(friend.socketId).emit('friend-added', { friend: { id: user.id, name: user.name, pin: user.pin, avatar: user.avatar, online: true } });
      io.to(friend.socketId).emit('notification', { message: `${user.name} added you!` });
    }
  });

  // GET FRIENDS
  socket.on('get-friends', () => {
    const userId = sockets.get(socket.id);
    if (userId) socket.emit('friends-list', { friends: getFriendsList(userId) });
  });

  // ===== DIRECT VOICE (Walkie-Talkie) =====
  // No call concept - just hold and talk, voice goes directly
  socket.on('voice-start', ({ friendId }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const user = users.get(userId);
    const friend = users.get(friendId);
    if (!friend || !friend.socketId) {
      socket.emit('voice-failed', { message: 'Friend is offline!' });
      return;
    }
    // Tell friend that someone started talking
    io.to(friend.socketId).emit('voice-incoming', {
      fromId: userId,
      fromName: user.name,
      fromAvatar: user.avatar
    });
  });

  socket.on('voice-chunk', ({ friendId, audioData }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const friend = users.get(friendId);
    if (friend && friend.socketId) {
      io.to(friend.socketId).emit('voice-chunk', { fromId: userId, audioData });
    }
  });

  socket.on('voice-stop', ({ friendId }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const friend = users.get(friendId);
    if (friend && friend.socketId) {
      io.to(friend.socketId).emit('voice-ended', { fromId: userId });
    }
  });

  // POKE
  socket.on('poke', ({ friendId, pokeType }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const user = users.get(userId);
    const friend = users.get(friendId);
    if (friend && friend.socketId) {
      io.to(friend.socketId).emit('poke-received', { fromName: user.name, type: pokeType || '👋' });
    }
  });

  // CHAT
  socket.on('chat-message', ({ friendId, message }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const user = users.get(userId);
    const friend = users.get(friendId);
    if (!friend || !friend.socketId) return;
    const msg = { fromId: userId, fromName: user.name, fromAvatar: user.avatar, message, timestamp: Date.now() };
    io.to(friend.socketId).emit('chat-message', msg);
    socket.emit('chat-message', { ...msg, toUserId: friendId });
  });

  // REMOVE FRIEND
  socket.on('remove-friend', ({ friendId }) => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const uf = friendships.get(userId);
    const ff = friendships.get(friendId);
    if (uf) uf.delete(friendId);
    if (ff) ff.delete(userId);
    saveData();
    const friend = users.get(friendId);
    if (friend && friend.socketId) io.to(friend.socketId).emit('friend-removed', { friendId: userId });
    socket.emit('friend-removed', { friendId });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const userId = sockets.get(socket.id);
    if (!userId) return;
    const user = users.get(userId);
    if (user) {
      user.socketId = null;
      user.online = false;
      notifyFriends(userId, false);
    }
    sockets.delete(socket.id);
  });
});

app.get('/api/health', (req, res) => {
  let online = 0;
  for (const [, u] of users) { if (u.socketId) online++; }
  res.json({ status: 'ok', users: online, total: users.size });
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Running on :${PORT}`));
