const state = {
  user: null,
  users: [],
  roomId: null,
  currentPeer: null,
  socket: null,
  onlineUsers: new Map(),
  messages: []
};

const els = {
  authScreen: document.getElementById('screen-auth'),
  chatScreen: document.getElementById('screen-chat'),
  loginForm: document.getElementById('form-login'),
  registerForm: document.getElementById('form-register'),
  authMessage: document.getElementById('auth-message'),
  tabs: Array.from(document.querySelectorAll('[data-auth-tab]')),
  meDisplay: document.getElementById('me-display'),
  contacts: document.getElementById('contacts'),
  emptyState: document.getElementById('empty-state'),
  chatPanel: document.getElementById('chat-panel'),
  chatTitle: document.getElementById('chat-title'),
  chatStatus: document.getElementById('chat-status'),
  messages: document.getElementById('messages'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  logoutBtn: document.getElementById('logout-btn'),
  adminPanel: document.getElementById('admin-panel'),
  createInviteForm: document.getElementById('create-invite-form'),
  invites: document.getElementById('invites'),
  enablePushBtn: document.getElementById('enable-push-btn')
};

boot();

async function boot() {
  bindEvents();
  await registerServiceWorker();
  await refreshSession();
}

function bindEvents() {
  els.tabs.forEach((tab) => tab.addEventListener('click', () => switchAuthTab(tab.dataset.authTab)));
  els.loginForm.addEventListener('submit', onLogin);
  els.registerForm.addEventListener('submit', onRegister);
  els.logoutBtn.addEventListener('click', onLogout);
  els.messageForm.addEventListener('submit', onSendMessage);
  els.createInviteForm.addEventListener('submit', onCreateInvite);
  els.enablePushBtn.addEventListener('click', enablePush);

  navigator.serviceWorker?.addEventListener('message', async (event) => {
    if (event.data?.type === 'notification-click') {
      await refreshCurrentRoom();
    }
  });
}

function switchAuthTab(name) {
  for (const tab of els.tabs) tab.classList.toggle('active', tab.dataset.authTab === name);
  els.loginForm.classList.toggle('hidden', name !== 'login');
  els.registerForm.classList.toggle('hidden', name !== 'register');
  setAuthMessage('');
}

async function refreshSession() {
  const result = await api('/api/me');
  if (!result.ok) {
    showAuth();
    return;
  }

  state.user = result.user;
  showChat();
  await Promise.all([loadUsers(), loadInvitesIfAdmin()]);
}

async function onLogin(event) {
  event.preventDefault();
  setAuthMessage('');
  const formData = new FormData(event.currentTarget);
  const payload = Object.fromEntries(formData.entries());
  const result = await api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) return setAuthMessage(result.error || 'Не удалось войти');
  state.user = result.user;
  event.currentTarget.reset();
  showChat();
  await Promise.all([loadUsers(), loadInvitesIfAdmin()]);
}

async function onRegister(event) {
  event.preventDefault();
  setAuthMessage('');
  const formData = new FormData(event.currentTarget);
  const payload = Object.fromEntries(formData.entries());
  const result = await api('/api/register', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) return setAuthMessage(result.error || 'Не удалось зарегистрироваться');
  state.user = result.user;
  event.currentTarget.reset();
  showChat();
  await Promise.all([loadUsers(), loadInvitesIfAdmin()]);
}

async function onLogout() {
  await api('/api/logout', { method: 'POST' });
  state.user = null;
  disconnectSocket();
  showAuth();
}

async function loadUsers() {
  const result = await api('/api/users');
  if (!result.ok) return;
  state.users = result.users;
  renderContacts();
}

function renderContacts() {
  els.contacts.innerHTML = '';
  for (const user of state.users) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'contact' + (state.currentPeer?.id === user.id ? ' active' : '');
    btn.innerHTML = `
      <div class="contact-meta">
        <strong>${escapeHtml(user.displayName)}</strong>
        <span class="muted">@${escapeHtml(user.username)}</span>
      </div>
      <span class="muted">${state.onlineUsers.has(user.id) ? 'в сети' : 'не в сети'}</span>
    `;
    btn.addEventListener('click', () => openDirectChat(user));
    els.contacts.appendChild(btn);
  }
}

async function openDirectChat(user) {
  state.currentPeer = user;
  renderContacts();
  els.emptyState.classList.add('hidden');
  els.chatPanel.classList.remove('hidden');
  els.chatTitle.textContent = user.displayName;
  updateChatStatus();

  const roomResult = await api(`/api/rooms/direct/${user.id}`, { method: 'POST' });
  if (!roomResult.ok) return;

  state.roomId = roomResult.roomId;
  await refreshCurrentRoom();
  connectSocket();
}

async function refreshCurrentRoom() {
  if (!state.roomId) return;
  const result = await api(`/api/rooms/${state.roomId}/messages?limit=100`);
  if (!result.ok) return;
  state.messages = result.messages;
  renderMessages();
}

function renderMessages() {
  els.messages.innerHTML = '';
  for (const message of state.messages) {
    const item = document.createElement('div');
    item.className = 'bubble' + (message.senderUserId === state.user.id ? ' me' : '');
    item.innerHTML = `
      <div class="bubble-head">${escapeHtml(message.senderDisplayName)} • ${formatDate(message.createdAt)}</div>
      <div class="bubble-text">${escapeHtml(message.body)}</div>
    `;
    els.messages.appendChild(item);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function onSendMessage(event) {
  event.preventDefault();
  if (!state.roomId) return;
  const body = els.messageInput.value.trim();
  if (!body) return;

  const result = await api(`/api/rooms/${state.roomId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body })
  });
  if (!result.ok) return;

  els.messageInput.value = '';
  els.messageInput.style.height = 'auto';
  state.messages.push(result.message);
  renderMessages();
}

function connectSocket() {
  disconnectSocket();
  if (!state.roomId) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/api/ws/${state.roomId}`);
  state.socket = socket;

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'message' && payload.message?.id) {
        if (!state.messages.find((item) => item.id === payload.message.id)) {
          state.messages.push(payload.message);
          renderMessages();
        }
      }
      if (payload.type === 'presence' || (payload.type === 'system' && payload.event === 'connected')) {
        state.onlineUsers = new Map((payload.onlineUsers || []).map((user) => [user.userId, user]));
        updateChatStatus();
        renderContacts();
      }
    } catch {
      // ignore
    }
  });

  socket.addEventListener('close', () => {
    if (state.roomId) {
      setTimeout(() => {
        if (!state.socket || state.socket.readyState === WebSocket.CLOSED) connectSocket();
      }, 1500);
    }
  });
}

function disconnectSocket() {
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

function updateChatStatus() {
  if (!state.currentPeer) {
    els.chatStatus.textContent = '';
    return;
  }
  els.chatStatus.textContent = state.onlineUsers.has(state.currentPeer.id) ? 'В сети' : 'Не в сети';
}

async function loadInvitesIfAdmin() {
  if (state.user?.role !== 'admin') {
    els.adminPanel.classList.add('hidden');
    return;
  }
  els.adminPanel.classList.remove('hidden');
  const result = await api('/api/admin/invites');
  if (!result.ok) return;
  els.invites.innerHTML = '';
  for (const invite of result.invites) {
    const item = document.createElement('div');
    item.className = 'invite-item';
    item.innerHTML = `
      <div class="invite-code">${escapeHtml(invite.code)}</div>
      <div class="muted">Использовано: ${invite.used_count}/${invite.max_uses}</div>
      ${invite.note ? `<div class="muted">${escapeHtml(invite.note)}</div>` : ''}
    `;
    item.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(invite.code);
        alert('Инвайт-код скопирован');
      } catch {
        // ignore
      }
    });
    els.invites.appendChild(item);
  }
}

async function onCreateInvite(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const result = await api('/api/admin/invites', { method: 'POST', body: JSON.stringify(payload) });
  if (!result.ok) return alert(result.error || 'Не удалось создать инвайт');
  event.currentTarget.reset();
  await loadInvitesIfAdmin();
  await navigator.clipboard.writeText(result.inviteCode).catch(() => {});
  alert(`Инвайт создан и скопирован:\n${result.inviteCode}`);
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('На этом устройстве Web Push недоступен');
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const publicKey = await getVapidKeyFromMeta();
  if (!publicKey) {
    alert('Сначала добавьте VAPID-ключи в Worker');
    return;
  }

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  const result = await api('/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ subscription: subscription.toJSON() })
  });

  if (!result.ok) {
    alert(result.error || 'Не удалось включить уведомления');
    return;
  }

  alert('Уведомления включены');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  await navigator.serviceWorker.register('/sw.js');
}

function showAuth() {
  els.authScreen.classList.remove('hidden');
  els.chatScreen.classList.add('hidden');
}

function showChat() {
  els.authScreen.classList.add('hidden');
  els.chatScreen.classList.remove('hidden');
  els.meDisplay.textContent = `${state.user.displayName} (@${state.user.username})`;
}

function setAuthMessage(text) {
  els.authMessage.textContent = text;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  return response.json().catch(() => ({ ok: false, error: 'Bad JSON response' }));
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

async function getVapidKeyFromMeta() {
  const response = await fetch('/api/vapid-public-key');
  const data = await response.json().catch(() => null);
  return data?.publicKey || null;
}
