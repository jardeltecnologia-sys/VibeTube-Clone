import { api, getToken, setToken } from './api.js';
import { MeshManager } from './mesh.js';
import { CallManager } from './calls.js';
import * as e2ee from './e2ee.js';

// ------------------------------------------------------------------ state
const state = {
  me: null,
  socket: null,
  mesh: null,
  calls: null,
  chats: new Map(),       // chatId -> summary
  activeChatId: null,
  messages: new Map(),    // chatId -> [message]
  presence: new Map(),    // userId -> { online, lastSeen }
  typing: new Map(),      // chatId -> Map(userId -> displayName)
  replyTo: null,
  editing: null,
  online: navigator.onLine,
  e2eeReady: false,
  keyCache: new Map(),    // chatId -> AES CryptoKey (or null if peer has no key)
};

// ------------------------------------------------------------------ helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function avatarBg(node, url, name) {
  if (url) { node.style.backgroundImage = `url(${url})`; node.textContent = ''; }
  else { node.style.backgroundImage = 'none'; node.textContent = initials(name); }
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoje';
  if (d.toDateString() === yest.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtLastSeen(ts) {
  if (!ts) return 'visto por último há algum tempo';
  return `visto por último ${fmtDay(ts).toLowerCase()} às ${fmtTime(ts)}`;
}

function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function lastMessagePreview(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 Mensagem apagada';
  if (m.type === 'image') return '📷 Foto';
  if (m.type === 'audio') return '🎤 Mensagem de voz';
  if (m.type === 'file') return `📎 ${m.mediaName || 'Arquivo'}`;
  if (m.type === 'system') return m.body || '';
  if (m.encrypted) {
    const known = findMessageById(m.id);
    const plain = (known && known._plain != null) ? known._plain : (m._plain != null ? m._plain : null);
    return plain != null ? plain : '🔒 Mensagem criptografada';
  }
  return m.body || '';
}

// ------------------------------------------------------------------ auth screen
function setupAuthScreen() {
  $$('.auth-tab').forEach((tab) => {
    tab.onclick = () => {
      $$('.auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
      $('#register-form').classList.toggle('hidden', tab.dataset.tab !== 'register');
      $('#auth-error').textContent = '';
    };
  });

  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { token, user } = await api.login({ email: fd.get('email'), password: fd.get('password') });
      setToken(token);
      await startApp(user);
    } catch (err) { $('#auth-error').textContent = err.message; }
  };

  $('#register-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const { token, user } = await api.register({
        displayName: fd.get('displayName'),
        username: fd.get('username') || undefined,
        email: fd.get('email'),
        password: fd.get('password'),
      });
      setToken(token);
      await startApp(user);
    } catch (err) { $('#auth-error').textContent = err.message; }
  };
}

// ------------------------------------------------------------------ socket
function connectSocket() {
  const socket = io({ auth: { token: getToken() } });
  state.socket = socket;

  socket.on('connect', () => { updateNetIndicator(); flushOutbox(); });
  socket.on('disconnect', () => updateNetIndicator());
  socket.on('connect_error', (e) => {
    if (e.message === 'unauthorized') logout();
  });

  socket.on('message:new', ({ message, clientId }) => {
    addMessage(message, clientId);
    if (message.chatId === state.activeChatId && message.senderId !== state.me.id) {
      socket.emit('chat:read', { chatId: message.chatId });
    } else if (message.senderId !== state.me.id) {
      socket.emit('message:delivered', { messageId: message.id, chatId: message.chatId });
    }
  });

  socket.on('chat:update', (summary) => {
    if (!summary) return;
    state.chats.set(summary.id, summary);
    renderChatList();
    if (summary.id === state.activeChatId) renderChatHeader(summary);
  });

  socket.on('chat:removed', ({ chatId }) => {
    state.chats.delete(chatId);
    state.messages.delete(chatId);
    state.keyCache.delete(chatId);
    if (chatId === state.activeChatId) {
      state.activeChatId = null;
      $('#chat-view').classList.add('hidden');
      $('#empty-state').classList.remove('hidden');
      $('#app').classList.remove('in-chat');
    }
    renderChatList();
  });

  socket.on('typing', ({ chatId, userId, displayName, isTyping }) => {
    if (!state.typing.has(chatId)) state.typing.set(chatId, new Map());
    const map = state.typing.get(chatId);
    if (isTyping) map.set(userId, displayName); else map.delete(userId);
    if (chatId === state.activeChatId) renderTyping();
    renderChatList();
  });

  socket.on('presence', ({ userId, status, lastSeen }) => {
    state.presence.set(userId, { online: status === 'online', lastSeen });
    if (state.activeChatId) {
      const chat = state.chats.get(state.activeChatId);
      if (chat && chat.type === 'direct' && chat.otherUser && chat.otherUser.id === userId) {
        renderChatHeader(chat);
      }
    }
    // Try opening a mesh link with peers who just came online.
    if (status === 'online' && state.mesh && state.mesh.enabled) state.mesh.connect(userId);
  });

  socket.on('receipt', ({ chatId }) => {
    if (chatId === state.activeChatId) reloadActiveMessages(true);
  });

  socket.on('message:reaction', ({ messageId, reactions }) => {
    for (const list of state.messages.values()) {
      const m = list.find((x) => x.id === messageId);
      if (m) { m.reactions = reactions; break; }
    }
    if (state.activeChatId) renderMessages();
  });

  socket.on('message:deleted', ({ messageId, chatId }) => {
    const list = state.messages.get(chatId);
    if (list) {
      const m = list.find((x) => x.id === messageId);
      if (m) { m.deleted = true; m.body = null; m.mediaUrl = null; }
    }
    if (chatId === state.activeChatId) renderMessages();
    renderChatList();
  });

  socket.on('message:expired', ({ messageId, chatId }) => {
    const list = state.messages.get(chatId);
    if (list) {
      const idx = list.findIndex((x) => x.id === messageId);
      if (idx !== -1) list.splice(idx, 1);
    }
    if (chatId === state.activeChatId) renderMessages(true);
    renderChatList();
  });

  socket.on('message:edited', ({ messageId, chatId, body, encrypted, editedAt }) => {
    const list = state.messages.get(chatId);
    const m = list && list.find((x) => x.id === messageId);
    if (m) {
      m.body = body;
      m.encrypted = encrypted;
      m.editedAt = editedAt;
      if (encrypted) { m._plain = null; m._decryptFailed = false; decryptInto(m); }
    }
    if (chatId === state.activeChatId) renderMessages(true);
    renderChatList();
  });

  // Mesh signaling relayed through the server.
  socket.on('mesh:signal', ({ from, signal }) => {
    if (state.mesh) state.mesh.onSignal(from, signal);
  });
}

// ------------------------------------------------------------------ mesh
function setupMesh() {
  state.mesh = new MeshManager({
    selfId: state.me.id,
    sendSignal: (to, signal) => state.socket.emit('mesh:signal', { to, signal }),
  });
  state.mesh.addEventListener('status', updateNetIndicator);
  // Messages arriving directly over a peer link (used when the server is down).
  state.mesh.addEventListener('message', (ev) => {
    const { data } = ev.detail;
    if (data.kind === 'message' && data.message) addMessage(data.message);
  });
}

function setupCalls() {
  state.calls = new CallManager({ socket: state.socket, selfId: state.me.id });
}

function startCall(media) {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  if (chat.type !== 'direct' || !chat.otherUser) {
    toast('Chamadas em grupo ainda não são suportadas');
    return;
  }
  state.calls.startCall(chat.otherUser, media);
}

// ------------------------------------------------------------------ encryption
// Resolve (and cache) the shared AES key for a direct chat. null = not encrypted.
async function ensureChatKey(chat) {
  if (!state.e2eeReady || !chat || chat.type !== 'direct' || !chat.otherUser) return null;
  if (state.keyCache.has(chat.id)) return state.keyCache.get(chat.id);
  let pub = chat.otherUser.publicKey;
  if (!pub) {
    try { const { user } = await api.getUser(chat.otherUser.id); pub = user.publicKey; } catch {}
  }
  const key = pub ? await e2ee.deriveChatKey(pub) : null;
  state.keyCache.set(chat.id, key);
  return key;
}

function chatIsEncrypted(chat) {
  return Boolean(chat && chat.type === 'direct' && state.keyCache.get(chat.id));
}

// Decrypt an incoming encrypted message in place, then refresh the views.
async function decryptInto(m) {
  const chat = state.chats.get(m.chatId);
  const key = await ensureChatKey(chat);
  if (!key) { m._decryptFailed = true; }
  else {
    try { m._plain = await e2ee.decrypt(key, m.body); m._decryptFailed = false; }
    catch { m._decryptFailed = true; }
  }
  if (m.chatId === state.activeChatId) renderMessages(true);
  renderChatList();
}

// Plaintext to display for a message (handles encrypted bodies).
function displayText(m) {
  if (!m.encrypted) return m.body;
  if (m._plain != null) return m._plain;
  return null; // not yet decrypted (or failed)
}

// ------------------------------------------------------------------ data load
async function loadChats() {
  const { chats } = await api.listChats();
  state.chats.clear();
  for (const c of chats) state.chats.set(c.id, c);
  renderChatList();
}

async function openChat(chatId) {
  state.activeChatId = chatId;
  state.replyTo = null;
  $('#reply-preview').classList.add('hidden');
  $('#empty-state').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#app').classList.add('in-chat');

  const chat = state.chats.get(chatId);
  await ensureChatKey(chat); // derive E2EE key up front so messages decrypt immediately
  renderChatHeader(chat);
  renderChatList();

  const { messages } = await api.getMessages(chatId);
  state.messages.set(chatId, messages);
  for (const m of messages) if (m.encrypted && m._plain == null) decryptInto(m);
  renderMessages();
  renderTyping();

  state.socket.emit('chat:read', { chatId });
}

async function reloadActiveMessages(silent) {
  if (!state.activeChatId) return;
  const { messages } = await api.getMessages(state.activeChatId);
  state.messages.set(state.activeChatId, messages);
  renderMessages(silent);
}

function addMessage(message, clientId) {
  if (!state.messages.has(message.chatId)) state.messages.set(message.chatId, []);
  const list = state.messages.get(message.chatId);

  // Reconcile an optimistic (locally-queued) message with the server's copy.
  if (clientId) {
    const opt = list.find((m) => m.clientId === clientId);
    if (opt) {
      Object.assign(opt, message, { pending: false, failed: false, clientId });
      removeFromOutbox(clientId);
      if (message.chatId === state.activeChatId) renderMessages();
      renderChatList();
      return;
    }
  }
  if (list.find((m) => m.id === message.id)) return; // already have it
  list.push(message);
  if (message.encrypted && message._plain == null) decryptInto(message);
  if (message.chatId === state.activeChatId) renderMessages();
}

// ------------------------------------------------------------------ render: chat list
let showArchived = false;

function chatItemNode(chat) {
  const avatar = el('span', { class: 'avatar' });
  avatarBg(avatar, chat.avatarUrl, chat.title);

  const typingMap = state.typing.get(chat.id);
  let preview;
  if (typingMap && typingMap.size) {
    preview = el('span', { class: 'chat-item-last', style: 'color:var(--accent)' }, 'digitando…');
  } else {
    preview = el('span', { class: 'chat-item-last' }, lastMessagePreview(chat.lastMessage));
  }

  const badge = chat.unread > 0
    ? el('span', { class: `badge${chat.muted ? ' muted' : ''}` }, String(chat.unread))
    : '';

  const menuBtn = el('button', { class: 'chat-item-menu', title: 'Opções',
    onclick: (e) => { e.stopPropagation(); openChatMenu(e.currentTarget, chat); } }, '⋮');

  return el('li', {
    class: `chat-item${chat.id === state.activeChatId ? ' active' : ''}`,
    onclick: () => openChat(chat.id),
  },
    avatar,
    el('div', { class: 'chat-item-body' },
      el('div', { class: 'chat-item-row' },
        el('span', { class: 'chat-item-name' },
          chat.pinned ? '📌 ' : '', chat.muted ? '🔇 ' : '', chat.title),
        el('span', { class: 'chat-item-time' },
          chat.lastMessage ? fmtTime(chat.lastMessage.createdAt) : '')),
      el('div', { class: 'chat-item-preview' }, preview, badge)),
    menuBtn);
}

function renderChatList() {
  const filter = $('#chat-search').value.trim().toLowerCase();
  const list = $('#chat-list');
  list.innerHTML = '';
  const all = [...state.chats.values()].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const at = a.lastMessage ? a.lastMessage.createdAt : 0;
    const bt = b.lastMessage ? b.lastMessage.createdAt : 0;
    return bt - at;
  });
  const visible = all.filter((c) => (!filter || c.title.toLowerCase().includes(filter)));
  const archived = visible.filter((c) => c.archived);
  const active = visible.filter((c) => !c.archived);

  if (archived.length) {
    list.append(el('li', { class: 'archived-toggle', onclick: () => { showArchived = !showArchived; renderChatList(); } },
      `${showArchived ? '▾' : '▸'} Arquivadas (${archived.length})`));
    if (showArchived) for (const chat of archived) list.append(chatItemNode(chat));
  }
  for (const chat of active) list.append(chatItemNode(chat));
}

// Lightweight popup menu for a chat (pin / archive / mute).
function openChatMenu(anchor, chat) {
  document.querySelector('.popup-menu')?.remove();
  const menu = el('div', { class: 'popup-menu' });
  const item = (label, fn) => el('div', { class: 'popup-item', onclick: async (e) => {
    e.stopPropagation(); menu.remove(); await fn();
  } }, label);

  menu.append(item(chat.pinned ? 'Desafixar' : 'Fixar', () => api.pinChat(chat.id, !chat.pinned).then(applyChatPatch)));
  menu.append(item(chat.archived ? 'Desarquivar' : 'Arquivar', () => api.archiveChat(chat.id, !chat.archived).then(applyChatPatch)));
  menu.append(item(chat.muted ? 'Reativar som' : 'Silenciar 8h', () =>
    api.muteChat(chat.id, chat.muted ? 0 : Date.now() + 8 * 3600 * 1000).then(applyChatPatch)));

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - 170)}px`;
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function applyChatPatch({ chat }) {
  if (chat) { state.chats.set(chat.id, chat); renderChatList(); }
}

// Search messages: server covers plaintext; the client covers E2EE messages it
// has already decrypted locally. Results are appended below the chat list.
async function performMessageSearch(q) {
  const query = (q || '').toLowerCase();
  if (query.length < 2) return; // chat-title filtering already handled by renderChatList

  let serverResults = [];
  try { serverResults = (await api.searchMessages(q)).results; } catch { /* offline: local only */ }
  // Drop results for a stale query (user kept typing).
  if ($('#chat-search').value.trim().toLowerCase() !== query) return;

  // Local matches over decrypted encrypted messages (server can't read those).
  const localResults = [];
  for (const list of state.messages.values()) {
    for (const m of list) {
      if (m.encrypted && !m.deleted && m._plain && m._plain.toLowerCase().includes(query)) {
        localResults.push({ messageId: m.id, chatId: m.chatId, senderId: m.senderId,
          type: m.type, body: m._plain, createdAt: m.createdAt });
      }
    }
  }

  const seen = new Set();
  const merged = [...serverResults, ...localResults]
    .filter((r) => state.chats.has(r.chatId) && !seen.has(r.messageId) && seen.add(r.messageId))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);

  const listEl = $('#chat-list');
  if (!merged.length) {
    listEl.append(el('li', { class: 'archived-toggle' }, `Nenhuma mensagem encontrada para "${q}"`));
    return;
  }
  listEl.append(el('li', { class: 'search-section-head' }, `Mensagens (${merged.length})`));
  for (const r of merged) {
    const chat = state.chats.get(r.chatId);
    const avatar = el('span', { class: 'avatar' });
    avatarBg(avatar, chat.avatarUrl, chat.title);
    const snippet = r.type === 'text' ? (r.body || '') : `📎 ${r.mediaName || r.type}`;
    listEl.append(el('li', { class: 'chat-item', onclick: () => { $('#chat-search').value = ''; renderChatList(); openChat(r.chatId); } },
      avatar,
      el('div', { class: 'chat-item-body' },
        el('div', { class: 'chat-item-row' },
          el('span', { class: 'chat-item-name' }, chat.title),
          el('span', { class: 'chat-item-time' }, fmtTime(r.createdAt))),
        el('div', { class: 'chat-item-preview' },
          el('span', { class: 'chat-item-last' }, snippet)))));
  }
}

// ------------------------------------------------------------------ render: header
function presenceText(chat) {
  if (chat.type === 'group') {
    return `${chat.members.length} participantes`;
  }
  const other = chat.otherUser;
  if (!other) return '';
  const p = state.presence.get(other.id);
  if (p && p.online) return 'online';
  const seen = (p && p.lastSeen) || other.lastSeen;
  return fmtLastSeen(seen);
}

function renderChatHeader(chat) {
  if (!chat) return;
  // Calls are 1:1 only — hide the buttons for groups.
  $('#chat-header-actions').style.display = chat.type === 'direct' ? 'flex' : 'none';
  avatarBg($('#chat-header-avatar'), chat.avatarUrl, chat.title);
  $('#chat-header-title').textContent = chat.title;
  const sub = $('#chat-header-sub');
  const typingMap = state.typing.get(chat.id);
  if (typingMap && typingMap.size) {
    sub.textContent = chat.type === 'group'
      ? `${[...typingMap.values()][0]} está digitando…`
      : 'digitando…';
    sub.classList.add('typing');
  } else {
    const prefix = (chatIsEncrypted(chat) ? '🔒 ' : '') + (chat.disappearingTimer ? '⏱ ' : '');
    sub.textContent = prefix + presenceText(chat);
    sub.classList.remove('typing');
  }
}

function renderTyping() {
  const chat = state.chats.get(state.activeChatId);
  if (chat) renderChatHeader(chat);
}

// ------------------------------------------------------------------ render: messages
function tickFor(message, chat) {
  if (message.senderId !== state.me.id || chat.type === 'system') return '';
  if (message.failed) {
    return el('span', { class: 'tick failed', title: 'Falha — toque para reenviar',
      onclick: () => retryMessage(message) }, '⚠');
  }
  if (message.pending) return el('span', { class: 'tick', title: 'Enviando…' }, '🕐');
  const others = chat.members.filter((m) => m.id !== state.me.id).map((m) => m.id);
  const readAll = others.length && others.every((id) => message.readBy.includes(id));
  const deliveredAll = others.length && others.every((id) => message.deliveredTo.includes(id));
  if (readAll) return el('span', { class: 'tick read' }, '✓✓');
  if (deliveredAll) return el('span', { class: 'tick' }, '✓✓');
  return el('span', { class: 'tick' }, '✓');
}

function findMessageById(id) {
  for (const list of state.messages.values()) {
    const m = list.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

function renderMessages(keepScroll) {
  const chat = state.chats.get(state.activeChatId);
  const container = $('#messages');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.innerHTML = '';
  const list = state.messages.get(state.activeChatId) || [];

  let lastDay = null;
  for (const m of list) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) {
      container.append(el('div', { class: 'day-divider' }, fmtDay(m.createdAt)));
      lastDay = day;
    }
    if (m.type === 'system') {
      container.append(el('div', { class: 'system-msg' }, m.body));
      continue;
    }
    const mine = m.senderId === state.me.id;
    const sender = chat.members.find((x) => x.id === m.senderId);

    const parts = [];
    if (chat.type === 'group' && !mine) {
      parts.push(el('div', { class: 'msg-sender' }, sender ? sender.displayName : 'Alguém'));
    }
    if (m.forwarded && !m.deleted) {
      parts.push(el('div', { class: 'msg-forwarded' }, '↪ Encaminhada'));
    }
    if (m.replyTo) {
      const r = findMessageById(m.replyTo);
      const rSender = r && chat.members.find((x) => x.id === r.senderId);
      parts.push(el('div', { class: 'msg-reply' },
        el('span', { class: 'rname' }, rSender ? rSender.displayName : ''),
        el('span', { class: 'rtext' }, r ? lastMessagePreview(r) : 'mensagem')));
    }

    if (m.deleted) {
      parts.push(el('div', { class: 'msg-body msg-deleted' }, '🚫 Esta mensagem foi apagada'));
    } else {
      if (m.type === 'image' && m.mediaUrl) {
        parts.push(el('div', { class: 'msg-media' },
          el('img', { src: m.mediaUrl, loading: 'lazy', onclick: () => window.open(m.mediaUrl, '_blank') })));
      } else if (m.type === 'audio' && m.mediaUrl) {
        parts.push(el('div', { class: 'msg-audio' },
          el('audio', { controls: '', src: m.mediaUrl, preload: 'none' })));
      } else if (m.type === 'file' && m.mediaUrl) {
        parts.push(el('a', { class: 'msg-file', href: m.mediaUrl, target: '_blank' },
          el('span', { class: 'file-ic' }, '📄'),
          el('span', {}, m.mediaName || 'Arquivo')));
      }
      const text = displayText(m);
      if (m.encrypted && text == null) {
        parts.push(el('div', { class: 'msg-body msg-encrypted' },
          m._decryptFailed ? '🔒 Não foi possível decifrar' : '🔒 Decifrando…'));
      } else if (text) {
        parts.push(el('div', { class: 'msg-body' }, text));
      }
    }

    const meta = el('div', { class: 'msg-meta' },
      m.editedAt && !m.deleted ? el('span', { class: 'edited-label' }, 'editada') : '',
      fmtTime(m.createdAt),
      mine && !m.deleted ? tickFor(m, chat) : '');
    parts.push(meta);

    if (m.reactions && m.reactions.length) {
      const emojis = [...new Set(m.reactions.map((r) => r.emoji))].join('');
      parts.push(el('div', { class: 'msg-reactions' }, `${emojis} ${m.reactions.length}`));
    }

    const actions = el('div', { class: 'msg-actions' },
      m.deleted ? '' : el('button', { title: 'Responder', onclick: () => setReply(m) }, '↩'),
      m.deleted ? '' : el('button', { title: 'Reagir', onclick: () => react(m, '👍') }, '👍'),
      m.deleted ? '' : el('button', { title: 'Encaminhar', onclick: () => forwardMessage(m) }, '↪'),
      mine && !m.deleted && m.type === 'text'
        ? el('button', { title: 'Editar', onclick: () => startEdit(m) }, '✎') : '',
      mine && !m.deleted ? el('button', { title: 'Apagar', onclick: () => deleteMessage(m) }, '🗑') : '');
    parts.push(actions);

    container.append(el('div', { class: `msg ${mine ? 'out' : 'in'}` }, ...parts));
  }

  if (!keepScroll || atBottom) container.scrollTop = container.scrollHeight;
}

// ------------------------------------------------------------------ message actions
function setReply(m) {
  state.editing = null;
  state.replyTo = m;
  const sender = (state.chats.get(state.activeChatId).members || []).find((x) => x.id === m.senderId);
  $('#reply-preview-name').textContent = sender ? sender.displayName : '';
  $('#reply-preview-text').textContent = lastMessagePreview(m);
  $('#reply-preview').classList.remove('hidden');
  $('#message-input').focus();
}
function clearReply() {
  state.replyTo = null;
  state.editing = null;
  $('#reply-preview').classList.add('hidden');
}
function react(m, emoji) { state.socket.emit('message:react', { messageId: m.id, emoji }); }
function deleteMessage(m) {
  if (confirm('Apagar esta mensagem para todos?')) state.socket.emit('message:delete', { messageId: m.id });
}

// Begin editing one of my own text messages (reuses the reply bar as an editor).
function startEdit(m) {
  state.replyTo = null;
  state.editing = m;
  $('#reply-preview-name').textContent = 'Editando mensagem';
  $('#reply-preview-text').textContent = displayText(m) || '';
  $('#reply-preview').classList.remove('hidden');
  const input = $('#message-input');
  input.value = displayText(m) || '';
  input.focus();
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

async function applyEdit(newText) {
  const m = state.editing;
  state.editing = null;
  $('#reply-preview').classList.add('hidden');
  if (!m || !newText.trim()) return;
  const chat = state.chats.get(m.chatId);
  let payload = { messageId: m.id, body: newText.trim() };
  const key = await ensureChatKey(chat);
  if (key) {
    payload.body = JSON.stringify(await e2ee.encrypt(key, newText.trim()));
    payload.encrypted = true;
    m._plain = newText.trim();
  } else {
    m._plain = null;
    m.body = newText.trim();
  }
  m.encrypted = Boolean(key);
  m.editedAt = Date.now();
  renderMessages(true);
  state.socket.emit('message:edit', payload);
}

// Forward a message into another chat (encrypting if that chat is encrypted).
function forwardMessage(m) {
  const chats = [...state.chats.values()].filter((c) => c.id);
  const list = el('div', {});
  for (const c of chats) {
    const avatar = el('span', { class: 'avatar sm' });
    avatarBg(avatar, c.avatarUrl, c.title);
    list.append(el('div', { class: 'user-result', onclick: async () => {
      backdrop.remove();
      await doForward(m, c.id);
    } },
      avatar,
      el('div', { class: 'user-result-body' },
        el('div', { class: 'user-result-name' }, c.title),
        el('div', { class: 'user-result-sub' }, c.type === 'group' ? 'Grupo' : 'Contato'))));
  }
  const body = el('div', { class: 'modal-body' }, list);
  const backdrop = modalShell('Encaminhar para…', body);
}

async function doForward(m, targetChatId) {
  const target = state.chats.get(targetChatId);
  const payload = { chatId: targetChatId, type: m.type, forwarded: true };
  if (m.type === 'text') {
    const text = displayText(m);
    if (text == null) return toast('Não é possível encaminhar uma mensagem cifrada ainda não decifrada');
    payload.body = text;
    let plainText;
    const key = await ensureChatKey(target);
    if (key) {
      payload.body = JSON.stringify(await e2ee.encrypt(key, text));
      payload.encrypted = true;
      plainText = text;
    }
    queueAndSend(payload, plainText);
  } else {
    payload.mediaUrl = m.mediaUrl;
    payload.mediaName = m.mediaName;
    payload.mediaMime = m.mediaMime;
    queueAndSend(payload);
  }
  toast(`Encaminhada para ${target.title}`);
  if (targetChatId !== state.activeChatId) openChat(targetChatId);
}

// ---- offline outbox: queued sends survive flaky networks and reconnects ----
function outboxKey() { return `speedvox_outbox_${state.me.id}`; }
function loadOutbox() {
  try { return JSON.parse(localStorage.getItem(outboxKey()) || '[]'); } catch { return []; }
}
function saveOutbox(items) { localStorage.setItem(outboxKey(), JSON.stringify(items)); }
function addToOutbox(payload) {
  const items = loadOutbox();
  items.push(payload);
  saveOutbox(items);
}
function removeFromOutbox(clientId) {
  saveOutbox(loadOutbox().filter((p) => p.clientId !== clientId));
}

function newClientId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `c${Date.now()}-${Math.random()}`);
}

// Build the optimistic message shown immediately while delivery is in flight.
function optimisticMessage(payload) {
  return {
    id: `local-${payload.clientId}`,
    clientId: payload.clientId,
    chatId: payload.chatId,
    senderId: state.me.id,
    type: payload.type || 'text',
    body: payload.body || null,
    mediaUrl: payload.mediaUrl || null,
    mediaName: payload.mediaName || null,
    mediaMime: payload.mediaMime || null,
    replyTo: payload.replyTo || null,
    forwarded: Boolean(payload.forwarded),
    encrypted: Boolean(payload.encrypted),
    createdAt: Date.now(),
    deleted: false,
    reactions: [],
    readBy: [],
    deliveredTo: [],
    pending: true,
    failed: false,
  };
}

// Try to deliver one queued payload. Updates pending/failed state on the bubble.
function deliver(payload) {
  if (!state.socket || !state.socket.connected) {
    // No server link — flood over the mesh if it is up, otherwise stay queued.
    if (state.mesh && state.mesh.enabled) {
      state.mesh.broadcast({ kind: 'message', message: optimisticMessage(payload) });
    }
    return;
  }
  state.socket.emit('message:send', payload, (res) => {
    if (res && res.error) markFailed(payload.clientId);
    else if (res && res.ok) removeFromOutbox(payload.clientId);
  });
  // Safety net: if no ack/echo arrives, flag the message as failed so it can be retried.
  setTimeout(() => {
    const m = findByClientId(payload.clientId);
    if (m && m.pending) markFailed(payload.clientId);
  }, 12000);
}

function findByClientId(clientId) {
  for (const list of state.messages.values()) {
    const m = list.find((x) => x.clientId === clientId);
    if (m) return m;
  }
  return null;
}

function markFailed(clientId) {
  const m = findByClientId(clientId);
  if (m && m.pending) { m.failed = true; m.pending = false; renderMessages(true); }
}

function retryMessage(message) {
  const items = loadOutbox();
  const payload = items.find((p) => p.clientId === message.clientId)
    || { clientId: message.clientId, chatId: message.chatId, type: message.type, body: message.body,
         mediaUrl: message.mediaUrl, mediaName: message.mediaName, mediaMime: message.mediaMime,
         replyTo: message.replyTo };
  message.failed = false;
  message.pending = true;
  renderMessages(true);
  deliver(payload);
}

// Re-send everything still queued (called on (re)connect).
function flushOutbox() {
  for (const payload of loadOutbox()) deliver(payload);
}

// plainText: original plaintext to show optimistically when payload.body is ciphertext.
function queueAndSend(payload, plainText) {
  payload.clientId = newClientId();
  addToOutbox(payload);
  const opt = optimisticMessage(payload);
  if (plainText != null) opt._plain = plainText;
  addMessage(opt);
  deliver(payload);
}

async function sendMessage() {
  const input = $('#message-input');
  const body = input.value.trim();
  if (!body || !state.activeChatId) return;

  // Editing an existing message takes priority over sending a new one.
  if (state.editing) {
    input.value = '';
    input.style.height = 'auto';
    await applyEdit(body);
    return;
  }

  const chat = state.chats.get(state.activeChatId);
  const payload = { chatId: state.activeChatId, body, type: 'text' };
  if (state.replyTo) payload.replyTo = state.replyTo.id;

  // Encrypt end-to-end for direct chats whose peer has a published key.
  let plainText;
  const key = await ensureChatKey(chat);
  if (key) {
    const env = await e2ee.encrypt(key, body);
    payload.body = JSON.stringify(env);
    payload.encrypted = true;
    plainText = body;
  }

  // Input may have changed during async encryption; only clear if unchanged.
  queueAndSend(payload, plainText);
  input.value = '';
  input.style.height = 'auto';
  clearReply();
  if (state.socket && state.socket.connected) {
    state.socket.emit('typing', { chatId: state.activeChatId, isTyping: false });
  }
}

async function sendFile(file) {
  if (!file || !state.activeChatId) return;
  try {
    toast('Enviando…');
    const up = await api.upload(file);
    const isImage = (up.mime || '').startsWith('image/');
    queueAndSend({
      chatId: state.activeChatId,
      type: isImage ? 'image' : 'file',
      mediaUrl: up.url,
      mediaName: up.name,
      mediaMime: up.mime,
      replyTo: state.replyTo ? state.replyTo.id : undefined,
    });
    clearReply();
  } catch (err) { toast('Falha no envio: ' + err.message); }
}

// ------------------------------------------------------------------ composer
let typingTimer = null;
function setupComposer() {
  const input = $('#message-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    if (!state.activeChatId) return;
    state.socket.emit('typing', { chatId: state.activeChatId, isTyping: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(
      () => state.socket.emit('typing', { chatId: state.activeChatId, isTyping: false }), 1800);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  $('#send-btn').onclick = sendMessage;
  $('#reply-cancel').onclick = () => {
    if (state.editing) { $('#message-input').value = ''; $('#message-input').style.height = 'auto'; }
    clearReply();
  };
  $('#attach-btn').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { if (e.target.files[0]) sendFile(e.target.files[0]); e.target.value = ''; };
  $('#back-btn').onclick = () => {
    state.activeChatId = null;
    $('#app').classList.remove('in-chat');
    $('#chat-view').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    renderChatList();
  };
  let searchTimer;
  $('#chat-search').addEventListener('input', () => {
    renderChatList();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performMessageSearch($('#chat-search').value.trim()), 220);
  });
  $('#chat-header-info').onclick = showChatInfo;
  $('#call-audio-btn').onclick = () => startCall('audio');
  $('#call-video-btn').onclick = () => startCall('video');
  $('#mic-btn').onclick = toggleVoiceRecording;
}

// ------------------------------------------------------------------ voice messages
let mediaRecorder = null;
let recordedChunks = [];
async function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!state.activeChatId) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast('Não foi possível acessar o microfone');
    return;
  }
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    $('#mic-btn').classList.remove('recording');
    $('#composer-rec')?.remove();
    $('#message-input').style.display = '';
    const blob = new Blob(recordedChunks, { type: 'audio/webm' });
    if (blob.size < 800) return; // ignore accidental taps
    const file = new File([blob], `voz-${Date.now()}.webm`, { type: 'audio/webm' });
    try {
      const up = await api.upload(file);
      queueAndSend({
        chatId: state.activeChatId,
        type: 'audio',
        mediaUrl: up.url,
        mediaName: 'Mensagem de voz',
        mediaMime: up.mime,
      });
    } catch (err) { toast('Falha ao enviar áudio: ' + err.message); }
  };
  mediaRecorder.start();
  $('#mic-btn').classList.add('recording');
  const composer = document.querySelector('.composer');
  composer.classList.add('recording');
  const rec = el('div', { class: 'rec-indicator', id: 'composer-rec' },
    el('span', { class: 'rec-dot' }), 'Gravando… toque no microfone para enviar');
  $('#message-input').style.display = 'none';
  composer.insertBefore(rec, $('#mic-btn'));
  const stopCleanup = () => composer.classList.remove('recording');
  mediaRecorder.addEventListener('stop', stopCleanup, { once: true });
}

// ------------------------------------------------------------------ modals
function openModal(node) {
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } }, node);
  $('#modal-root').append(backdrop);
  return backdrop;
}

function modalShell(title, bodyNode, footerNode) {
  const backdropRef = { current: null };
  const modal = el('div', { class: 'modal' },
    el('div', { class: 'modal-header' },
      el('h3', {}, title),
      el('button', { class: 'icon-btn', onclick: () => backdropRef.current.remove() }, '✕')),
    bodyNode,
    footerNode || '');
  const backdrop = openModal(modal);
  backdropRef.current = backdrop;
  return backdrop;
}

function userResultRow(user, { selectable, selected, onToggle }) {
  const avatar = el('span', { class: 'avatar sm' });
  avatarBg(avatar, user.avatarUrl, user.displayName);
  return el('div', { class: 'user-result', onclick: () => onToggle(user) },
    avatar,
    el('div', { class: 'user-result-body' },
      el('div', { class: 'user-result-name' }, user.displayName),
      el('div', { class: 'user-result-sub' }, '@' + user.username)),
    selectable && selected ? el('span', { class: 'check' }, '✓') : '');
}

function newChatModal() {
  const results = el('div', {});
  const search = el('input', { type: 'text', placeholder: 'Buscar por nome, usuário ou e-mail' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      results.innerHTML = '';
      if (q.length < 2) return;
      const { users } = await api.searchUsers(q);
      if (!users.length) { results.append(el('p', { class: 'auth-hint' }, 'Nenhum usuário encontrado.')); return; }
      for (const u of users) {
        results.append(userResultRow(u, {
          selectable: false,
          onToggle: async () => {
            const { chat } = await api.openDirect(u.id);
            state.chats.set(chat.id, chat);
            state.socket.emit('chat:join', { chatId: chat.id });
            backdrop.remove();
            await openChat(chat.id);
          },
        }));
      }
    }, 250);
  });
  const body = el('div', { class: 'modal-body' }, search, results);
  const backdrop = modalShell('Nova conversa', body);
  setTimeout(() => search.focus(), 50);
}

function newGroupModal() {
  const selected = new Map();
  const nameInput = el('input', { type: 'text', placeholder: 'Nome do grupo' });
  const search = el('input', { type: 'text', placeholder: 'Adicionar participantes' });
  const selectedRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px' });
  const results = el('div', {});

  function renderSelected() {
    selectedRow.innerHTML = '';
    for (const u of selected.values()) {
      selectedRow.append(el('span', { class: 'badge', style: 'background:var(--panel-3);color:var(--text);cursor:pointer',
        onclick: () => { selected.delete(u.id); renderSelected(); } }, u.displayName + ' ✕'));
    }
  }
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      results.innerHTML = '';
      if (q.length < 2) return;
      const { users } = await api.searchUsers(q);
      for (const u of users) {
        results.append(userResultRow(u, {
          selectable: true, selected: selected.has(u.id),
          onToggle: () => {
            if (selected.has(u.id)) selected.delete(u.id); else selected.set(u.id, u);
            renderSelected();
            search.dispatchEvent(new Event('input'));
          },
        }));
      }
    }, 250);
  });

  const create = el('button', { class: 'btn-primary', onclick: async () => {
    if (!nameInput.value.trim()) return toast('Informe o nome do grupo');
    const { chat } = await api.createGroup(nameInput.value.trim(), [...selected.keys()]);
    state.chats.set(chat.id, chat);
    state.socket.emit('chat:join', { chatId: chat.id });
    backdrop.remove();
    await openChat(chat.id);
  } }, 'Criar grupo');

  const body = el('div', { class: 'modal-body' }, nameInput, selectedRow, search, results);
  const footer = el('div', { class: 'modal-footer' }, create);
  const backdrop = modalShell('Novo grupo', body, footer);
  setTimeout(() => nameInput.focus(), 50);
}

// Make an avatar node clickable to upload a new image. onUploaded receives the URL.
function makeAvatarUploadable(node, name, onUploaded) {
  node.style.cursor = 'pointer';
  node.title = 'Alterar foto';
  const input = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const up = await api.upload(file);
      avatarBg(node, up.url, name);
      onUploaded(up.url);
    } catch (err) { toast('Falha ao enviar imagem: ' + err.message); }
  };
  node.onclick = () => input.click();
  node.append(input);
  return node;
}

function profileModal() {
  const big = el('div', { class: 'profile-avatar-big' });
  avatarBg(big, state.me.avatarUrl, state.me.displayName);
  let pendingAvatar = null;
  makeAvatarUploadable(big, state.me.displayName, (url) => { pendingAvatar = url; });
  const nameInput = el('input', { type: 'text', value: state.me.displayName });
  const aboutInput = el('input', { type: 'text', value: state.me.about || '' });
  const save = el('button', { class: 'btn-primary', onclick: async () => {
    const data = { displayName: nameInput.value, about: aboutInput.value };
    if (pendingAvatar) data.avatarUrl = pendingAvatar;
    const { user } = await api.updateProfile(data);
    state.me = user;
    refreshMyAvatar();
    backdrop.remove();
    toast('Perfil atualizado');
  } }, 'Salvar');

  const body = el('div', { class: 'modal-body' },
    big,
    el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, 'Nome'), nameInput),
    el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, 'Recado'), aboutInput),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Usuário'),
      el('div', {}, '@' + state.me.username)),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Modo mesh (resiliência em apagão)'),
      meshToggleRow()));
  const footer = el('div', { class: 'modal-footer' }, save);
  const backdrop = modalShell('Perfil', body, footer);
}

function meshToggleRow() {
  const label = el('span', {}, state.mesh.enabled ? 'Ativado' : 'Desativado');
  const btn = el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0' },
    state.mesh.enabled ? 'Desativar' : 'Ativar');
  btn.onclick = () => {
    state.mesh.setEnabled(!state.mesh.enabled);
    label.textContent = state.mesh.enabled ? 'Ativado' : 'Desativado';
    btn.textContent = state.mesh.enabled ? 'Desativar' : 'Ativar';
    if (state.mesh.enabled) {
      // Try to peer with everyone we currently know is online.
      for (const [uid, p] of state.presence) if (p.online) state.mesh.connect(uid);
      toast('Modo mesh ativado: mensagens podem trafegar peer-to-peer');
    }
  };
  return el('div', { style: 'display:flex;align-items:center;gap:12px' }, btn, label);
}

// Dropdown to choose the disappearing-messages timer for a chat.
function disappearingRow(chat) {
  const options = [
    { v: 0, label: 'Desligado' },
    { v: 86400, label: '24 horas' },
    { v: 7 * 86400, label: '7 dias' },
    { v: 90 * 86400, label: '90 dias' },
  ];
  const select = el('select', { class: 'select-input' });
  for (const o of options) {
    const opt = el('option', { value: String(o.v) }, o.label);
    if (o.v === (chat.disappearingTimer || 0)) opt.setAttribute('selected', '');
    select.append(opt);
  }
  select.onchange = async () => {
    const { chat: updated } = await api.setDisappearing(chat.id, parseInt(select.value, 10));
    state.chats.set(updated.id, updated);
    renderChatHeader(updated);
    toast(parseInt(select.value, 10) ? 'Mensagens temporárias ativadas' : 'Mensagens temporárias desativadas');
  };
  return el('div', { class: 'field-row' },
    el('div', { class: 'field-label' }, '⏱ Mensagens temporárias'), select);
}

function showChatInfo() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  const isGroup = chat.type === 'group';
  const iAmAdmin = isGroup && (chat.members.find((m) => m.id === state.me.id) || {}).role === 'admin';

  const big = el('div', { class: 'profile-avatar-big' });
  avatarBg(big, chat.avatarUrl, chat.title);
  if (isGroup && iAmAdmin) {
    makeAvatarUploadable(big, chat.title, async (url) => {
      await api.updateChat(chat.id, { avatarUrl: url });
      toast('Foto do grupo atualizada');
    });
  }

  // Editable title for group admins.
  let titleNode;
  if (isGroup && iAmAdmin) {
    const titleInput = el('input', { type: 'text', value: chat.title, style: 'text-align:center;font-size:18px' });
    const saveName = el('button', { class: 'icon-btn', title: 'Salvar nome', onclick: async () => {
      if (titleInput.value.trim() && titleInput.value.trim() !== chat.title) {
        await api.updateChat(chat.id, { name: titleInput.value.trim() });
        toast('Nome do grupo atualizado');
      }
    } }, '✓');
    titleNode = el('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px' }, titleInput, saveName);
  } else {
    titleNode = el('h3', { style: 'text-align:center;margin-bottom:6px' }, chat.title);
  }

  const members = el('div', {});
  function renderMembers() {
    members.innerHTML = '';
    const fresh = state.chats.get(chat.id);
    if (!fresh) return;
    for (const m of fresh.members) {
      const avatar = el('span', { class: 'avatar sm' });
      avatarBg(avatar, m.avatarUrl, m.displayName);
      const actions = [];
      if (iAmAdmin && m.id !== state.me.id) {
        actions.push(el('button', { class: 'icon-btn', title: m.role === 'admin' ? 'Remover admin' : 'Tornar admin',
          onclick: async () => { await api.setMemberRole(chat.id, m.id, m.role === 'admin' ? 'member' : 'admin'); setTimeout(renderMembers, 150); } },
          m.role === 'admin' ? '★' : '☆'));
        actions.push(el('button', { class: 'icon-btn', title: 'Remover do grupo',
          onclick: async () => { if (confirm(`Remover ${m.displayName}?`)) { await api.removeMember(chat.id, m.id); setTimeout(renderMembers, 150); } } }, '✕'));
      }
      members.append(el('div', { class: 'user-result' },
        avatar,
        el('div', { class: 'user-result-body' },
          el('div', { class: 'user-result-name' }, m.displayName + (m.id === state.me.id ? ' (você)' : '')),
          el('div', { class: 'user-result-sub' }, m.role === 'admin' ? 'Admin · @' + m.username : '@' + m.username)),
        ...actions));
    }
  }
  renderMembers();
  // Refresh the member list when the server pushes group changes.
  const refresh = () => setTimeout(renderMembers, 50);
  state.socket.on('chat:update', refresh);

  const addBtn = (isGroup && iAmAdmin)
    ? el('button', { class: 'btn-primary', style: 'margin-top:12px', onclick: () => addMembersModal(chat.id, () => setTimeout(renderMembers, 200)) }, '+ Adicionar participantes')
    : '';

  const leave = el('button', { class: 'btn-primary', style: 'background:var(--danger);margin-top:16px', onclick: async () => {
    await api.leaveChat(chat.id);
    state.chats.delete(chat.id);
    state.activeChatId = null;
    $('#chat-view').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#app').classList.remove('in-chat');
    renderChatList();
    backdrop.remove();
  } }, isGroup ? 'Sair do grupo' : 'Apagar conversa');

  const body = el('div', { class: 'modal-body' },
    big,
    titleNode,
    el('p', { class: 'auth-hint' }, presenceText(chat)),
    el('div', { style: 'margin-top:16px' }, disappearingRow(chat)),
    el('div', { class: 'field-label' }, isGroup ? `${chat.members.length} participantes` : 'Contato'),
    members,
    addBtn,
    leave);
  const backdrop = modalShell(isGroup ? 'Dados do grupo' : 'Dados do contato', body);
  // Detach the live refresh listener when the modal closes.
  const origRemove = backdrop.remove.bind(backdrop);
  backdrop.remove = () => { state.socket.off('chat:update', refresh); origRemove(); };
}

// Modal to pick and add participants to an existing group.
function addMembersModal(chatId, onDone) {
  const selected = new Map();
  const search = el('input', { type: 'text', placeholder: 'Buscar pessoas' });
  const results = el('div', {});
  const chat = state.chats.get(chatId);
  const existing = new Set((chat ? chat.members : []).map((m) => m.id));
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      results.innerHTML = '';
      if (search.value.trim().length < 2) return;
      const { users } = await api.searchUsers(search.value.trim());
      for (const u of users) {
        if (existing.has(u.id)) continue;
        results.append(userResultRow(u, { selectable: true, selected: selected.has(u.id),
          onToggle: () => { selected.has(u.id) ? selected.delete(u.id) : selected.set(u.id, u); search.dispatchEvent(new Event('input')); } }));
      }
    }, 250);
  });
  const add = el('button', { class: 'btn-primary', onclick: async () => {
    if (!selected.size) return;
    await api.addMembers(chatId, [...selected.keys()]);
    backdrop.remove();
    onDone && onDone();
  } }, 'Adicionar');
  const body = el('div', { class: 'modal-body' }, search, results);
  const footer = el('div', { class: 'modal-footer' }, add);
  const backdrop = modalShell('Adicionar participantes', body, footer);
  setTimeout(() => search.focus(), 50);
}

// ------------------------------------------------------------------ chrome
function refreshMyAvatar() {
  avatarBg($('#my-avatar-btn'), state.me.avatarUrl, state.me.displayName);
}

function updateNetIndicator() {
  const ind = $('#net-indicator');
  const meshOn = state.mesh && state.mesh.enabled && state.mesh.status().peers > 0;
  if (state.socket && state.socket.connected) {
    ind.className = 'net-indicator';
    ind.title = meshOn ? `Online + ${state.mesh.status().peers} peers mesh` : 'Online';
  } else if (meshOn) {
    ind.className = 'net-indicator mesh';
    ind.title = `Servidor offline · ${state.mesh.status().peers} peers via mesh`;
  } else {
    ind.className = 'net-indicator offline';
    ind.title = 'Reconectando…';
  }
}

function logout() {
  setToken(null);
  if (state.socket) state.socket.disconnect();
  location.reload();
}

// ------------------------------------------------------------------ boot
async function startApp(user) {
  state.me = user;
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  refreshMyAvatar();

  // Set up end-to-end encryption: generate/load the identity key and publish
  // the public half so contacts can encrypt to us. The private key never leaves
  // this device.
  if (e2ee.isAvailable()) {
    try {
      const pub = await e2ee.initIdentity();
      state.e2eeReady = true;
      if (pub && pub !== user.publicKey) {
        api.updateProfile({ publicKey: pub }).then(({ user: u }) => { state.me = u; }).catch(() => {});
      }
    } catch { /* encryption stays off; messaging still works in plaintext */ }
  }

  connectSocket();
  setupMesh();
  setupCalls();
  setupComposer();
  await loadChats();
  updateNetIndicator();

  $('#new-chat-btn').onclick = newChatModal;
  $('#new-group-btn').onclick = newGroupModal;
  $('#logout-btn').onclick = () => { if (confirm('Sair do SpeedVox?')) logout(); };
  $('#my-avatar-btn').onclick = profileModal;
}

async function boot() {
  setupAuthScreen();

  // Pick up a token handed back by the Google OAuth callback.
  if (location.hash.startsWith('#token=')) {
    setToken(decodeURIComponent(location.hash.slice(7)));
    history.replaceState(null, '', location.pathname);
  }

  window.addEventListener('online', () => { state.online = true; updateNetIndicator(); });
  window.addEventListener('offline', () => { state.online = false; updateNetIndicator(); });

  // Probe whether Google sign-in is configured to hide the button if not.
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    if (!h.google) {
      $('#google-btn').classList.add('hidden');
      $('#google-disabled').classList.remove('hidden');
    }
  } catch {}

  if (getToken()) {
    try {
      const { user } = await api.me();
      await startApp(user);
    } catch {
      setToken(null);
    }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
}

boot();
