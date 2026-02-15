const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map(); // userId -> user data
const sockets = new Map(); // ws -> userId
const rooms = new Map(); // roomId -> room object
const roomMessages = new Map(); // roomId -> messages[]
const dmThreads = new Map(); // threadId -> messages[]

const GENERAL_ROOM = { id: 'general', name: 'General', createdBy: 'system', members: new Set(), createdAt: Date.now() };
rooms.set(GENERAL_ROOM.id, GENERAL_ROOM);
roomMessages.set(GENERAL_ROOM.id, []);

function safeSend(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function nowISO() {
  return new Date().toISOString();
}

function getThreadId(a, b) {
  return [a, b].sort().join('::');
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    bio: user.bio,
    status: user.status,
    theme: user.theme,
    avatarHue: user.avatarHue,
    followers: [...user.followers],
    following: [...user.following],
    joinedAt: user.joinedAt,
    online: user.online
  };
}

function serializeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    createdBy: room.createdBy,
    createdAt: room.createdAt,
    members: [...room.members]
  };
}

function emitPresence() {
  const onlineUsers = [...users.values()].map(toPublicUser);
  const payload = { type: 'presence:update', onlineUsers };
  for (const ws of sockets.keys()) safeSend(ws, payload);
}

function emitRooms() {
  const allRooms = [...rooms.values()].map(serializeRoom);
  const payload = { type: 'rooms:update', rooms: allRooms };
  for (const ws of sockets.keys()) safeSend(ws, payload);
}

function emitUserUpdated(user) {
  const payload = { type: 'user:update', user: toPublicUser(user) };
  for (const ws of sockets.keys()) safeSend(ws, payload);
}

function pushRoomMessage(roomId, message) {
  const list = roomMessages.get(roomId) || [];
  list.push(message);
  roomMessages.set(roomId, list.slice(-200));
}

function pushDmMessage(threadId, message) {
  const list = dmThreads.get(threadId) || [];
  list.push(message);
  dmThreads.set(threadId, list.slice(-200));
}

function buildBootstrap(userId) {
  const user = users.get(userId);
  const onlineUsers = [...users.values()].map(toPublicUser);
  const roomsList = [...rooms.values()].map(serializeRoom);
  const roomHistory = Object.fromEntries(
    [...roomMessages.entries()].map(([k, v]) => [k, v])
  );

  const dmHistory = {};
  for (const [threadId, messages] of dmThreads.entries()) {
    if (threadId.includes(userId)) dmHistory[threadId] = messages;
  }

  return {
    type: 'bootstrap',
    self: toPublicUser(user),
    onlineUsers,
    rooms: roomsList,
    roomHistory,
    dmHistory
  };
}

function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 700);
}

function mentionTargets(text) {
  const found = [...text.matchAll(/@([a-zA-Z0-9_\-]{2,30})/g)].map((m) => m[1].toLowerCase());
  if (!found.length) return [];
  const hits = [];
  for (const u of users.values()) {
    if (found.includes(u.username.toLowerCase())) hits.push(u.id);
  }
  return hits;
}

wss.on('connection', (ws) => {
  let authenticatedUserId = null;

  safeSend(ws, { type: 'hello', message: 'Connected. Please authenticate.' });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: 'error', message: 'Invalid message format.' });
      return;
    }

    if (msg.type === 'auth') {
      const username = normalizeText(msg.username || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 24);
      if (username.length < 3) {
        safeSend(ws, { type: 'error', message: 'Username must have at least 3 characters.' });
        return;
      }

      const userId = msg.userId && users.has(msg.userId)
        ? msg.userId
        : `u_${Math.random().toString(36).slice(2, 10)}`;

      const existing = [...users.values()].find((u) => u.username.toLowerCase() === username.toLowerCase() && u.id !== userId);
      if (existing) {
        safeSend(ws, { type: 'error', message: 'Username already in use.' });
        return;
      }

      const previous = users.get(userId);
      const user = previous || {
        id: userId,
        username,
        bio: normalizeText(msg.bio || 'No bio yet.'),
        status: 'Ready to chat ✨',
        theme: msg.theme === 'light' ? 'light' : 'dark',
        avatarHue: Number.isFinite(Number(msg.avatarHue)) ? Number(msg.avatarHue) % 360 : Math.floor(Math.random() * 360),
        followers: new Set(),
        following: new Set(),
        joinedAt: nowISO(),
        online: true
      };

      user.username = username;
      user.bio = normalizeText(msg.bio || user.bio || 'No bio yet.');
      user.online = true;
      users.set(userId, user);
      sockets.set(ws, userId);
      authenticatedUserId = userId;

      GENERAL_ROOM.members.add(userId);
      emitRooms();
      safeSend(ws, buildBootstrap(userId));
      emitPresence();
      return;
    }

    if (!authenticatedUserId || !users.has(authenticatedUserId)) {
      safeSend(ws, { type: 'error', message: 'Authenticate first.' });
      return;
    }

    const sender = users.get(authenticatedUserId);

    if (msg.type === 'profile:update') {
      sender.bio = normalizeText(msg.bio || sender.bio);
      sender.status = normalizeText(msg.status || sender.status).slice(0, 90);
      if (msg.theme === 'light' || msg.theme === 'dark') sender.theme = msg.theme;
      if (Number.isFinite(Number(msg.avatarHue))) sender.avatarHue = Number(msg.avatarHue) % 360;
      emitUserUpdated(sender);
      return;
    }

    if (msg.type === 'follow:toggle') {
      const targetId = msg.targetId;
      if (!targetId || !users.has(targetId) || targetId === sender.id) return;
      const target = users.get(targetId);
      if (sender.following.has(targetId)) {
        sender.following.delete(targetId);
        target.followers.delete(sender.id);
      } else {
        sender.following.add(targetId);
        target.followers.add(sender.id);
      }
      emitUserUpdated(sender);
      emitUserUpdated(target);
      return;
    }

    if (msg.type === 'room:create') {
      const name = normalizeText(msg.name).slice(0, 40);
      if (name.length < 2) {
        safeSend(ws, { type: 'error', message: 'Room name too short.' });
        return;
      }
      const roomId = `r_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${Math.random().toString(36).slice(2, 6)}`;
      const room = {
        id: roomId,
        name,
        createdBy: sender.id,
        createdAt: nowISO(),
        members: new Set([sender.id])
      };
      rooms.set(roomId, room);
      roomMessages.set(roomId, []);
      emitRooms();
      return;
    }

    if (msg.type === 'room:join') {
      const room = rooms.get(msg.roomId);
      if (!room) return;
      room.members.add(sender.id);
      emitRooms();
      return;
    }

    if (msg.type === 'room:leave') {
      const room = rooms.get(msg.roomId);
      if (!room || room.id === GENERAL_ROOM.id) return;
      room.members.delete(sender.id);
      emitRooms();
      return;
    }

    if (msg.type === 'room:message') {
      const room = rooms.get(msg.roomId);
      const text = normalizeText(msg.text);
      if (!room || !room.members.has(sender.id) || !text) return;
      const mentionIds = mentionTargets(text);
      const message = {
        id: `m_${Math.random().toString(36).slice(2, 10)}`,
        roomId: room.id,
        senderId: sender.id,
        senderName: sender.username,
        text,
        mentions: mentionIds,
        ts: nowISO()
      };
      pushRoomMessage(room.id, message);
      for (const client of sockets.keys()) safeSend(client, { type: 'room:message', message });
      return;
    }

    if (msg.type === 'dm:message') {
      const targetId = msg.targetId;
      const text = normalizeText(msg.text);
      if (!targetId || !users.has(targetId) || targetId === sender.id || !text) return;
      const threadId = getThreadId(sender.id, targetId);
      const mentionIds = mentionTargets(text);
      const message = {
        id: `d_${Math.random().toString(36).slice(2, 10)}`,
        threadId,
        senderId: sender.id,
        senderName: sender.username,
        to: targetId,
        text,
        mentions: mentionIds,
        ts: nowISO()
      };
      pushDmMessage(threadId, message);
      for (const [client, uid] of sockets.entries()) {
        if (uid === sender.id || uid === targetId) safeSend(client, { type: 'dm:message', message });
      }
      return;
    }

    if (msg.type === 'typing') {
      const payload = {
        type: 'typing',
        from: sender.id,
        senderName: sender.username,
        roomId: msg.roomId || null,
        targetId: msg.targetId || null,
        isTyping: Boolean(msg.isTyping)
      };
      for (const [client, uid] of sockets.entries()) {
        if (uid === sender.id) continue;
        if (payload.targetId && uid !== payload.targetId) continue;
        safeSend(client, payload);
      }
      return;
    }
  });

  ws.on('close', () => {
    const userId = sockets.get(ws);
    sockets.delete(ws);
    if (!userId || !users.has(userId)) return;
    const user = users.get(userId);
    user.online = false;
    for (const room of rooms.values()) {
      if (room.id !== GENERAL_ROOM.id) room.members.delete(userId);
      else room.members.add(userId);
    }
    emitPresence();
    emitRooms();
  });
});

server.listen(PORT, () => {
  console.log(`FrostChat listening on http://localhost:${PORT}`);
});
