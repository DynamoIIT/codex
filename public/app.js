const state = {
  ws: null,
  self: null,
  users: new Map(),
  rooms: new Map(),
  roomHistory: {},
  dmHistory: {},
  currentView: { type: 'room', id: 'general' },
  typingTimers: new Map(),
  unreadDMs: new Map()
};

const el = {
  authOverlay: document.getElementById('auth-overlay'),
  authForm: document.getElementById('auth-form'),
  username: document.getElementById('username'),
  bio: document.getElementById('bio'),
  app: document.getElementById('app'),
  avatar: document.getElementById('avatar'),
  meName: document.getElementById('me-name'),
  meStatus: document.getElementById('me-status'),
  roomsList: document.getElementById('rooms-list'),
  usersList: document.getElementById('users-list'),
  dmsList: document.getElementById('dms-list'),
  chatTitle: document.getElementById('chat-title'),
  messages: document.getElementById('messages'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  typing: document.getElementById('typing-indicator'),
  newRoom: document.getElementById('new-room'),
  themeToggle: document.getElementById('theme-toggle'),
  editProfile: document.getElementById('edit-profile'),
  profileDialog: document.getElementById('profile-dialog'),
  profileForm: document.getElementById('profile-form'),
  profileStatus: document.getElementById('profile-status'),
  profileBio: document.getElementById('profile-bio'),
  profileHue: document.getElementById('profile-hue')
};

function getStoredAuth() {
  try { return JSON.parse(localStorage.getItem('frostchat-auth') || 'null'); }
  catch { return null; }
}

function setStoredAuth(payload) {
  localStorage.setItem('frostchat-auth', JSON.stringify(payload));
}

function send(type, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type, ...payload }));
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mentionHighlighted(text) {
  return text.replace(/@([a-zA-Z0-9_\-]+)/g, '<mark>@$1</mark>');
}

function renderSelf() {
  if (!state.self) return;
  el.meName.textContent = state.self.username;
  el.meStatus.textContent = state.self.status || state.self.bio || 'No status';
  el.avatar.style.background = `linear-gradient(145deg, hsla(${state.self.avatarHue},85%,55%,1), hsla(${(state.self.avatarHue + 80) % 360},80%,40%,1))`;
  document.body.classList.toggle('light', state.self.theme === 'light');
}

function roomName(roomId) {
  return state.rooms.get(roomId)?.name || 'Room';
}

function username(userId) {
  return state.users.get(userId)?.username || 'Unknown';
}

function currentMessages() {
  if (state.currentView.type === 'room') return state.roomHistory[state.currentView.id] || [];
  return state.dmHistory[state.currentView.id] || [];
}

function messageIsMention(msg) {
  return msg.mentions?.includes(state.self.id);
}

function renderMessages() {
  const items = currentMessages();
  el.messages.innerHTML = '';
  for (const msg of items) {
    const row = document.createElement('article');
    row.className = `msg ${msg.senderId === state.self.id ? 'self' : ''} ${messageIsMention(msg) ? 'mention' : ''}`;
    row.innerHTML = `
      <div class="meta">${msg.senderName} • ${formatTime(msg.ts)} ${messageIsMention(msg) ? '• pinged you' : ''}</div>
      <div class="text">${mentionHighlighted(msg.text)}</div>
    `;
    el.messages.appendChild(row);
  }
  el.messages.scrollTop = el.messages.scrollHeight;
}

function renderRooms() {
  el.roomsList.innerHTML = '';
  for (const room of state.rooms.values()) {
    const li = document.createElement('li');
    li.className = state.currentView.type === 'room' && state.currentView.id === room.id ? 'active' : '';
    li.innerHTML = `<span># ${room.name}</span><small>${room.members.length}</small>`;
    li.onclick = () => {
      state.currentView = { type: 'room', id: room.id };
      send('room:join', { roomId: room.id });
      el.chatTitle.textContent = `# ${room.name}`;
      renderRooms();
      renderDMs();
      renderMessages();
    };
    el.roomsList.appendChild(li);
  }
}

function renderUsers() {
  el.usersList.innerHTML = '';
  const users = [...state.users.values()].sort((a, b) => Number(b.online) - Number(a.online));

  for (const user of users) {
    if (user.id === state.self.id) continue;
    const li = document.createElement('li');
    const isFollowing = state.self.following.includes(user.id);
    li.innerHTML = `
      <div>
        <strong>${user.username}</strong>
        <div style="font-size:.76rem;color:var(--muted)">${user.status || user.bio || ''}</div>
      </div>
      <div class="user-actions">
        ${user.online ? '<span class="online-dot" title="Online"></span>' : ''}
        <button class="pill dm-btn">DM</button>
        <button class="pill follow-btn">${isFollowing ? 'Unfollow' : 'Follow'}</button>
      </div>
    `;
    li.querySelector('.dm-btn').onclick = () => openDM(user.id);
    li.querySelector('.follow-btn').onclick = () => send('follow:toggle', { targetId: user.id });
    el.usersList.appendChild(li);
  }
}

function threadIdWith(targetId) {
  return [state.self.id, targetId].sort().join('::');
}

function openDM(targetId) {
  const threadId = threadIdWith(targetId);
  state.currentView = { type: 'dm', id: threadId, targetId };
  state.unreadDMs.set(threadId, 0);
  el.chatTitle.textContent = `DM • ${username(targetId)}`;
  renderDMs();
  renderRooms();
  renderMessages();
}

function renderDMs() {
  el.dmsList.innerHTML = '';
  const entries = [...state.users.values()].filter((u) => u.id !== state.self.id);
  for (const user of entries) {
    const threadId = threadIdWith(user.id);
    if (!state.dmHistory[threadId] && !state.unreadDMs.get(threadId)) continue;
    const unread = state.unreadDMs.get(threadId) || 0;
    const li = document.createElement('li');
    li.className = state.currentView.type === 'dm' && state.currentView.id === threadId ? 'active' : '';
    li.innerHTML = `<span>${user.username}</span><small>${unread > 0 ? unread : ''}</small>`;
    li.onclick = () => openDM(user.id);
    el.dmsList.appendChild(li);
  }
}

function setTypingText(text = '') {
  el.typing.textContent = text;
}

function typingPulse() {
  if (state.currentView.type === 'room') {
    send('typing', { roomId: state.currentView.id, isTyping: true });
  } else {
    send('typing', { targetId: state.currentView.targetId, isTyping: true });
  }
}

function connect(authData) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}`);
  state.ws = ws;

  ws.onopen = () => send('auth', authData);

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'error') {
      alert(data.message);
      return;
    }

    if (data.type === 'bootstrap') {
      state.self = data.self;
      state.users = new Map(data.onlineUsers.map((u) => [u.id, u]));
      state.rooms = new Map(data.rooms.map((r) => [r.id, r]));
      state.roomHistory = data.roomHistory || {};
      state.dmHistory = data.dmHistory || {};

      setStoredAuth({ userId: state.self.id, username: state.self.username, bio: state.self.bio, theme: state.self.theme, avatarHue: state.self.avatarHue });
      el.authOverlay.classList.add('hidden');
      el.app.classList.remove('hidden');
      el.chatTitle.textContent = '# General';
      renderSelf();
      renderRooms();
      renderUsers();
      renderDMs();
      renderMessages();
      return;
    }

    if (data.type === 'presence:update') {
      state.users = new Map(data.onlineUsers.map((u) => [u.id, u]));
      state.self = state.users.get(state.self.id) || state.self;
      renderSelf();
      renderUsers();
      renderDMs();
      return;
    }

    if (data.type === 'rooms:update') {
      state.rooms = new Map(data.rooms.map((r) => [r.id, r]));
      renderRooms();
      return;
    }

    if (data.type === 'user:update') {
      state.users.set(data.user.id, data.user);
      if (data.user.id === state.self.id) state.self = data.user;
      renderSelf();
      renderUsers();
      return;
    }

    if (data.type === 'room:message') {
      const m = data.message;
      state.roomHistory[m.roomId] = [...(state.roomHistory[m.roomId] || []), m].slice(-200);
      if (state.currentView.type === 'room' && state.currentView.id === m.roomId) renderMessages();
      return;
    }

    if (data.type === 'dm:message') {
      const m = data.message;
      state.dmHistory[m.threadId] = [...(state.dmHistory[m.threadId] || []), m].slice(-200);
      if (!(state.currentView.type === 'dm' && state.currentView.id === m.threadId) && m.senderId !== state.self.id) {
        state.unreadDMs.set(m.threadId, (state.unreadDMs.get(m.threadId) || 0) + 1);
      }
      renderDMs();
      if (state.currentView.type === 'dm' && state.currentView.id === m.threadId) renderMessages();
      return;
    }

    if (data.type === 'typing') {
      const relevant = state.currentView.type === 'room'
        ? data.roomId === state.currentView.id
        : data.targetId === state.self.id && data.from === state.currentView.targetId;
      if (!relevant || !data.isTyping) return;
      const key = `${data.from}:${data.roomId || data.targetId}`;
      setTypingText(`${data.senderName} is typing...`);
      clearTimeout(state.typingTimers.get(key));
      state.typingTimers.set(key, setTimeout(() => setTypingText(''), 1300));
    }
  };

  ws.onclose = () => {
    setTypingText('Disconnected. Reconnecting...');
    setTimeout(() => connect(getStoredAuth() || { username: el.username.value, bio: el.bio.value }), 1200);
  };
}

el.authForm.onsubmit = (e) => {
  e.preventDefault();
  connect({ username: el.username.value.trim(), bio: el.bio.value.trim(), ...getStoredAuth() });
};

el.newRoom.onclick = () => {
  const name = prompt('Room name');
  if (name) send('room:create', { name });
};

el.messageForm.onsubmit = (e) => {
  e.preventDefault();
  const text = el.messageInput.value.trim();
  if (!text) return;
  if (state.currentView.type === 'room') {
    send('room:message', { roomId: state.currentView.id, text });
  } else {
    send('dm:message', { targetId: state.currentView.targetId, text });
  }
  el.messageInput.value = '';
  setTypingText('');
};

el.messageInput.oninput = () => typingPulse();

el.themeToggle.onclick = () => {
  const theme = state.self.theme === 'dark' ? 'light' : 'dark';
  send('profile:update', { theme, status: state.self.status, bio: state.self.bio, avatarHue: state.self.avatarHue });
};

el.editProfile.onclick = () => {
  el.profileStatus.value = state.self.status || '';
  el.profileBio.value = state.self.bio || '';
  el.profileHue.value = state.self.avatarHue;
  el.profileDialog.showModal();
};

el.profileForm.onsubmit = (e) => {
  e.preventDefault();
  if (e.submitter?.value !== 'save') return el.profileDialog.close();
  send('profile:update', {
    status: el.profileStatus.value.trim(),
    bio: el.profileBio.value.trim(),
    avatarHue: Number(el.profileHue.value),
    theme: state.self.theme
  });
  el.profileDialog.close();
};

const stored = getStoredAuth();
if (stored?.username) {
  el.username.value = stored.username;
  el.bio.value = stored.bio || '';
  connect(stored);
}
