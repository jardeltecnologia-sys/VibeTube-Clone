import { api, getToken, setToken } from './api.js';
import { API_BASE, apiUrl, mediaUrl, isNative } from './env.js';
import { MeshManager } from './mesh.js';
import { attachNearby } from './mesh-nearby.js';
import * as ringtone from './ringtone.js';
import * as offline from './offline.js';
import { CallManager } from './calls.js';
import { GroupCallManager } from './groupcall.js';
import * as e2ee from './e2ee.js';
import * as ratchet from './ratchet.js';
import { qrSVG } from './qrcode.js';
import { AUDIO_CONSTRAINTS } from './webrtc-quality.js';
import * as applock from './applock.js';

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
  iceServers: null,
  composerMentions: new Map(), // displayName -> userId, for the current draft
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
  if (url) { node.style.backgroundImage = `url(${mediaUrl(url)})`; node.textContent = ''; }
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

function parseCall(m) {
  try { return JSON.parse(m.body); } catch { return { media: 'audio', status: 'completed', duration: 0 }; }
}
function fmtDuration(s) {
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
function callLabel(m) {
  const c = parseCall(m);
  const icon = c.media === 'video' ? '📹' : '📞';
  const mine = m.senderId === state.me.id; // I was the caller
  if (c.status === 'missed') return `${icon} ${mine ? 'Chamada não atendida' : 'Chamada perdida'}`;
  if (c.status === 'rejected') return `${icon} Chamada recusada`;
  if (c.status === 'canceled') return `${icon} Chamada cancelada`;
  return `${icon} ${c.media === 'video' ? 'Chamada de vídeo' : 'Chamada de voz'}${c.duration ? ' · ' + fmtDuration(c.duration) : ''}`;
}

function lastMessagePreview(m) {
  if (!m) return '';
  if (m.deleted) return '🚫 Mensagem apagada';
  if (m.type === 'image') return '📷 Foto';
  if (m.type === 'video') return '🎬 Vídeo';
  if (m.type === 'audio') return '🎤 Mensagem de voz';
  if (m.type === 'file') return `📎 ${m.mediaName || 'Arquivo'}`;
  if (m.type === 'poll') return `📊 ${(m.poll && m.poll.question) || 'Enquete'}`;
  if (m.type === 'call') return callLabel(m);
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
    } catch (err) {
      if (err.status === 403 && err.data && err.data.needsVerification) {
        showVerificationNotice(err.data.email || fd.get('email'),
          'Confirme o seu e-mail antes de entrar. Verifique a sua caixa de entrada.');
      } else {
        $('#auth-error').textContent = err.message;
      }
    }
  };

  $('#link-device-btn').onclick = linkNewDeviceFlow;

  // "Esqueci minha senha": pede o e-mail e dispara o link de redefinição.
  $('#forgot-password-btn').onclick = async () => {
    const prefill = ($('#login-form').querySelector('[name=email]') || {}).value || '';
    const email = prompt('Digite o seu e-mail para receber o link de redefinição de senha:', prefill);
    if (!email || !email.trim()) return;
    const note = $('#auth-error');
    try {
      await api.forgotPassword(email.trim());
      note.style.color = '#00a884';
      note.textContent = 'Se este e-mail tiver uma conta, enviamos um link para redefinir a senha. Verifique a caixa de entrada (e o spam).';
    } catch (err) {
      note.style.color = '';
      note.textContent = err.message;
    }
  };

  $('#register-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api.register({
        displayName: fd.get('displayName'),
        username: fd.get('username') || undefined,
        email: fd.get('email'),
        password: fd.get('password'),
      });
      if (res.pending) {
        showVerificationNotice(res.email || fd.get('email'),
          res.message || 'Enviamos um e-mail de confirmação. Clique no link para ativar a sua conta.');
        return;
      }
      setToken(res.token);
      await startApp(res.user);
    } catch (err) { $('#auth-error').textContent = err.message; }
  };
}

// Shown after a pending registration or a login blocked by an unverified e-mail.
// Lets the user re-request the confirmation link (rate-limited on the server).
function showVerificationNotice(email, message) {
  $('#auth-error').textContent = '';
  const status = el('p', { class: 'auth-hint', style: 'margin-bottom:12px' }, message);
  const resendBtn = el('button', { class: 'btn-primary', type: 'button' }, 'Reenviar e-mail');
  resendBtn.onclick = async () => {
    resendBtn.disabled = true;
    try {
      await api.resendVerification(email);
      status.textContent = `Reenviamos o e-mail de confirmação para ${email}.`;
    } catch (err) {
      status.textContent = err.message;
    }
    setTimeout(() => { resendBtn.disabled = false; }, 4000);
  };
  const body = el('div', { class: 'modal-body', style: 'text-align:center' },
    el('h2', { style: 'color:var(--accent);margin:0 0 8px' }, '✉️ Confirme o seu e-mail'),
    status,
    el('p', { class: 'auth-hint', style: 'margin-bottom:16px;font-weight:600' }, email),
    resendBtn);
  const backdrop = modalShell('Verificação de e-mail', body);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) backdrop.remove(); });
}

// If the user just confirmed via the e-mail link, the page may be opened with
// ?verified=1 — greet them on the login screen.
function checkVerifiedParam() {
  const params = new URLSearchParams(location.search);
  if (params.get('verified') === '1') {
    const note = $('#auth-error');
    if (note) { note.style.color = 'var(--accent)'; note.textContent = 'E-mail confirmado! Já pode entrar.'; }
    history.replaceState(null, '', location.pathname);
  }
}

// New device: request a code, show it, and poll until an existing device approves.
async function linkNewDeviceFlow() {
  let code;
  try { ({ code } = await api.linkNew()); } catch { return toast('Falha ao iniciar vinculação'); }
  const qrWrap = el('div', { class: 'link-qr' });
  try { qrWrap.innerHTML = qrSVG(code, { size: 200, margin: 4 }); } catch { /* fall back to code only */ }
  const codeEl = el('div', { class: 'link-code' }, code);
  const status = el('p', { class: 'auth-hint' }, 'Aguardando aprovação no outro aparelho…');
  const body = el('div', { class: 'modal-body', style: 'text-align:center' },
    el('p', { class: 'auth-hint', style: 'margin-bottom:12px' }, 'Em um aparelho já conectado, abra Perfil → "Vincular um dispositivo" e escaneie o QR ou digite o código:'),
    qrWrap, codeEl, status);
  const backdrop = modalShell('Vincular dispositivo', body);

  let active = true;
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) active = false; });
  const poll = setInterval(async () => {
    if (!active) { clearInterval(poll); return; }
    let res;
    try { res = await api.linkStatus(code); } catch { return; }
    if (res.status === 'approved' && res.token) {
      clearInterval(poll); active = false;
      setToken(res.token);
      try { const { user } = await api.me(); backdrop.remove(); await startApp(user); }
      catch { toast('Falha ao entrar'); }
    } else if (res.status === 'expired' || res.status === 'invalid') {
      clearInterval(poll);
      status.textContent = 'Código expirado. Feche e tente novamente.';
      status.style.color = 'var(--danger)';
    }
  }, 2000);
}

// ------------------------------------------------------------------ socket
function connectSocket() {
  // Same-origin for the web/PWA; absolute server URL for the bundled native app.
  const socket = API_BASE
    ? io(API_BASE, { auth: { token: getToken() }, transports: ['websocket', 'polling'] })
    : io({ auth: { token: getToken() } });
  state.socket = socket;

  socket.on('connect', () => {
    updateNetIndicator();
    flushOutbox();
    // Internet is back: keep the mesh device registry fresh (best-effort).
    offline.registerDevice().catch(() => {});
  });
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
    // Audible nudge when a message lands while the app is open but the chat
    // isn't focused (or the window is in the background). When the app is fully
    // closed, the OS notification sound takes over via Web Push instead.
    if (message.senderId !== state.me.id &&
        (message.chatId !== state.activeChatId || document.hidden)) {
      ringtone.notify();
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

  socket.on('poll:update', ({ messageId, votes }) => {
    for (const list of state.messages.values()) {
      const m = list.find((x) => x.id === messageId);
      if (m && m.poll) { m.poll.votes = votes; break; }
    }
    if (state.activeChatId) renderMessages(true);
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

  socket.on('status:update', () => { refreshStatusIndicator(); });

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
    iceServers: state.iceServers,
  });
  state.mesh.addEventListener('status', updateNetIndicator);
  // A chat message relayed across the mesh (possibly several hops away). The
  // payload IS the message object; it may be E2EE ciphertext we then decrypt.
  state.mesh.addEventListener('message', (ev) => {
    const msg = ev.detail.data;
    if (msg && msg.chatId) addMessage(msg);
  });
  // A media item (voice note / photo / file) reassembled from mesh chunks.
  state.mesh.addEventListener('media', (ev) => onMeshMedia(ev.detail));
  // An emergency SOS flooded across the mesh — surface it loudly.
  state.mesh.addEventListener('sos', (ev) => onMeshSOS(ev.detail));
  // Native zero-infrastructure transport (BLE / Wi-Fi Direct) when running in
  // the Capacitor app; a no-op in plain browsers.
  state.meshNearby = attachNearby(state.mesh, { displayName: state.me.displayName });
}

// A media item (voice note, photo, file) arrived over the mesh, already
// reassembled from its chunks. Render it as a normal incoming message using a
// data: URL (no server needed) so it shows up offline, in a blackout.
function onMeshMedia({ from, chatId, type, mime, name, b64, ts }) {
  const cid = chatId && state.chats.has(chatId) ? chatId : null;
  if (!cid) return; // we don't have that conversation loaded; ignore for now
  const dataUrl = `data:${mime || 'application/octet-stream'};base64,${b64}`;
  addMessage({
    id: `mesh-${from}-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    chatId: cid,
    senderId: from,
    type: type || 'file',
    body: null,
    mediaUrl: dataUrl,
    mediaName: name || 'Arquivo',
    mediaMime: mime || null,
    mentions: [],
    forwarded: false,
    encrypted: false,
    createdAt: ts || Date.now(),
    deleted: false,
    reactions: [],
    readBy: [],
    deliveredTo: [],
  });
  if (cid !== state.activeChatId || document.hidden) ringtone.notify();
}

// Route a queued message into the mesh, addressed to its recipient(s). The mesh
// hops it toward them and holds it if no path exists yet.
function meshDeliver(payload) {
  const chat = state.chats.get(payload.chatId);
  if (!chat) return;
  const msg = optimisticMessage(payload);
  if (chat.type === 'direct' && chat.otherUser) {
    state.mesh.sendMessage(chat.otherUser.id, msg);
  } else if (chat.type === 'group' && Array.isArray(chat.members)) {
    for (const m of chat.members) if (m.id !== state.me.id) state.mesh.sendMessage(m.id, msg);
  }
}

// An SOS flooded across the mesh reached us — surface it as loudly as we can.
function onMeshSOS({ from, data }) {
  const name = (data && data.name) || 'Alguém';
  const text = (data && data.text) || 'Emergência!';
  const coords = data && data.coords;
  const banner = el('div', { class: 'sos-banner' },
    el('div', { class: 'sos-title' }, '🆘 SOS de ' + name),
    el('div', { class: 'sos-text' }, text));
  if (coords) {
    banner.append(el('a', { class: 'sos-map', target: '_blank', rel: 'noopener',
      href: `https://maps.google.com/?q=${coords.lat},${coords.lon}` }, '📍 Ver localização'));
  }
  banner.append(el('button', { class: 'sos-close', onclick: () => banner.remove() }, 'Fechar'));
  document.body.append(banner);
  try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400]); } catch {}
  try { ringtone.startIncoming(); setTimeout(() => ringtone.stop(), 4000); } catch {}
  try {
    if (window.Notification && Notification.permission === 'granted') {
      new Notification('🆘 SOS de ' + name, { body: text });
    }
  } catch {}
}

// Trigger an emergency SOS: turns on the mesh, grabs a best-effort location and
// floods every reachable device (and holds it for devices that appear later).
async function sendSOS() {
  if (!confirm('Enviar um alerta de EMERGÊNCIA (SOS) para todos os aparelhos próximos na malha?')) return;
  if (state.mesh && !state.mesh.enabled) {
    state.mesh.setEnabled(true);
    for (const …28804 tokens truncated…ser.avatarUrl, g.user.displayName);
      body.append(el('div', { class: 'user-result', onclick: () => { backdrop.remove(); viewStatuses(g.statuses, g.user, false); } },
        el('span', { class: `status-ring${g.hasUnviewed ? '' : ' seen'}` }, av),
        el('div', { class: 'user-result-body' },
          el('div', { class: 'user-result-name' }, g.user.displayName),
          el('div', { class: 'user-result-sub' }, `${g.statuses.length} atualização(ões) · ${fmtTime(g.latestAt)}`))));
    }
  } else {
    body.append(el('p', { class: 'auth-hint', style: 'margin-top:14px' }, 'Nenhuma atualização de contatos.'));
  }

  const backdrop = modalShell('Status', body);
}

function statusComposer() {
  let chosenColor = STATUS_COLORS[0];
  let pendingImage = null;

  const preview = el('div', { class: 'status-compose-preview', style: `background:${chosenColor}` });
  const textInput = el('textarea', { class: 'status-compose-text', placeholder: 'Digite um status', rows: '4' });
  textInput.oninput = () => { preview.textContent = textInput.value; };
  preview.append(textInput);

  const swatches = el('div', { class: 'status-swatches' });
  for (const c of STATUS_COLORS) {
    swatches.append(el('button', { class: 'swatch', style: `background:${c}`,
      onclick: () => { chosenColor = c; preview.style.background = c; if (pendingImage) { pendingImage = null; preview.style.backgroundImage = 'none'; } } }));
  }

  const fileInput = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    try {
      const up = await api.upload(f);
      pendingImage = up.url;
      preview.style.backgroundImage = `url(${up.url})`;
      preview.style.backgroundSize = 'cover';
      preview.style.backgroundPosition = 'center';
      textInput.placeholder = 'Legenda (opcional)';
    } catch (err) { toast('Falha no upload: ' + err.message); }
  };

  const photoBtn = el('button', { class: 'icon-btn', title: 'Foto', style: 'font-size:20px', onclick: () => fileInput.click() }, '📷');
  const post = el('button', { class: 'btn-primary', onclick: async () => {
    try {
      if (pendingImage) {
        await api.postStatus({ type: 'image', mediaUrl: pendingImage, body: textInput.value.trim() || undefined });
      } else {
        if (!textInput.value.trim()) return toast('Escreva algo ou escolha uma foto');
        await api.postStatus({ type: 'text', body: textInput.value.trim(), bgColor: chosenColor });
      }
      backdrop.remove();
      toast('Status publicado');
      refreshStatusIndicator();
    } catch (err) { toast('Falha: ' + err.message); }
  } }, 'Publicar');

  const body = el('div', { class: 'modal-body' }, preview,
    el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:10px' }, photoBtn, swatches, fileInput));
  const footer = el('div', { class: 'modal-footer' }, post);
  const backdrop = modalShell('Adicionar status', body, footer);
  setTimeout(() => textInput.focus(), 50);
}

// Full-screen status viewer with progress bars and auto-advance.
function viewStatuses(statuses, user, isMine) {
  let idx = 0;
  let timer = null;
  const overlay = el('div', { class: 'status-viewer' });

  const bars = el('div', { class: 'status-bars' });
  const barEls = statuses.map(() => {
    const fill = el('span', { class: 'status-bar-fill' });
    bars.append(el('span', { class: 'status-bar' }, fill));
    return fill;
  });

  const head = el('div', { class: 'status-viewer-head' });
  const av = el('span', { class: 'avatar sm' });
  avatarBg(av, user.avatarUrl, user.displayName);
  const headText = el('div', {}, el('div', { style: 'font-weight:600' }, isMine ? 'Meu status' : user.displayName), el('div', { class: 'status-time' }));
  const closeBtn = el('button', { class: 'icon-btn', style: 'color:#fff;font-size:22px;margin-left:auto', onclick: () => close() }, '✕');
  head.append(av, headText, closeBtn);

  const content = el('div', { class: 'status-viewer-content' });
  const footer = el('div', { class: 'status-viewer-foot' });

  overlay.append(bars, head, content, footer);
  document.body.append(overlay);

  function close() { if (timer) clearTimeout(timer); overlay.remove(); refreshStatusIndicator(); openStatusPanel(); }

  function render() {
    const s = statuses[idx];
    barEls.forEach((b, i) => { b.style.width = i < idx ? '100%' : (i === idx ? '0%' : '0%'); });
    headText.querySelector('.status-time').textContent = fmtTime(s.createdAt);
    content.innerHTML = '';
    content.style.background = s.bgColor || '#000';
    content.style.backgroundImage = '';
    if (s.type === 'image' && s.mediaUrl) {
      content.style.background = '#000';
      content.append(el('img', { class: 'status-img', src: mediaUrl(s.mediaUrl) }));
      if (s.body) content.append(el('div', { class: 'status-caption' }, s.body));
    } else {
      content.append(el('div', { class: 'status-text' }, s.body || ''));
    }
    footer.innerHTML = '';
    if (isMine) {
      footer.append(el('button', { class: 'status-viewers-btn', onclick: () => showStatusViewers(s.id) }, `👁 ${s.viewCount || 0}`));
      footer.append(el('button', { class: 'status-del-btn', onclick: async () => {
        await api.deleteStatus(s.id); toast('Status apagado'); close();
      } }, '🗑'));
    } else {
      api.viewStatus(s.id).catch(() => {});
    }
    // animate progress then advance
    requestAnimationFrame(() => { barEls[idx].style.transition = 'width 4.5s linear'; barEls[idx].style.width = '100%'; });
    if (timer) clearTimeout(timer);
    timer = setTimeout(next, 4500);
  }
  function next() { if (idx < statuses.length - 1) { idx++; barEls[idx - 1].style.transition = 'none'; render(); } else close(); }
  function prev() { if (idx > 0) { barEls[idx].style.transition = 'none'; barEls[idx].style.width = '0%'; idx--; barEls[idx].style.transition = 'none'; barEls[idx].style.width = '0%'; render(); } }

  content.onclick = (e) => { (e.clientX < window.innerWidth / 3) ? prev() : next(); };
  render();
}

async function showStatusViewers(statusId) {
  try {
    const { viewers } = await api.statusViewers(statusId);
    const body = el('div', { class: 'modal-body' },
      el('div', { class: 'field-label' }, `${viewers.length} visualização(ões)`));
    for (const v of viewers) {
      const av = el('span', { class: 'avatar sm' });
      avatarBg(av, v.avatarUrl, v.displayName);
      body.append(el('div', { class: 'user-result' }, av,
        el('div', { class: 'user-result-body' },
          el('div', { class: 'user-result-name' }, v.displayName),
          el('div', { class: 'user-result-sub' }, fmtTime(v.viewedAt)))));
    }
    if (!viewers.length) body.append(el('p', { class: 'auth-hint' }, 'Ninguém viu ainda.'));
    modalShell('Visualizações', body);
  } catch { toast('Falha ao carregar visualizações'); }
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
  // Só o botão "Sair" limpa a sessão de verdade (token + perfil/conversas em cache).
  setToken(null);
  localStorage.removeItem('speedvox_me');
  localStorage.removeItem('speedvox_chats');
  if (state.socket) state.socket.disconnect();
  location.reload();
}

// ------------------------------------------------------------------ boot
// ------------------------------------------------------------------ push
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Subscribe this device to Web Push so messages arrive when the app is closed.
async function setupPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  try {
    const { publicKey, enabled } = await api.pushVapid();
    if (!enabled || !publicKey) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api.pushSubscribe(sub);
  } catch { /* notifications are best-effort */ }
}

async function startApp(user) {
  state.me = user;
  // Guarda o perfil pra abrir o app offline (apagão) sem precisar do servidor.
  try { localStorage.setItem('speedvox_me', JSON.stringify(user)); } catch { /* storage cheio */ }
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

  // Fetch ICE servers (STUN + optional TURN) so calls work behind restrictive NATs.
  try { state.iceServers = (await (await fetch(apiUrl('/api/ice'))).json()).iceServers; } catch { state.iceServers = null; }

  connectSocket();
  setupMesh();
  // Generate/persist the offline cryptographic identity and register it with the
  // backend (best-effort). Failures never block the app (e.g. old WebView).
  offline.ensureIdentity(state.me.displayName)
    .then(() => offline.registerDevice().catch(() => {}))
    .catch((e) => console.warn('[offline] identidade indisponível:', e && e.message));
  setupCalls();
  setupComposer();
  await loadChats();
  updateNetIndicator();

  $('#fab-new-chat').onclick = newChatModal;
  $('#contacts-btn').onclick = contactsModal;
  $('#new-group-btn').onclick = newGroupModal;
  $('#logout-btn').onclick = () => { if (confirm('Sair do SpeedVox?')) logout(); };
  $('#my-avatar-btn').onclick = profileModal;
  $('#settings-btn').onclick = settingsModal;
  $('#status-btn').onclick = openStatusPanel;
  // The connection dot doubles as a shortcut to the Mesh/offline panel, so the
  // mesh feature is discoverable straight from the main screen.
  const netDot = $('#net-indicator');
  if (netDot) { netDot.style.cursor = 'pointer'; netDot.onclick = openOfflineMode; }

  setupPush();
  setupNativeCallPush().catch(() => {});
  refreshStatusIndicator();
}

// Native Android (Capacitor): register this device's FCM token so the server
// can ring incoming calls in full screen even with the app closed.
//
// The outcome is persisted so Configurações can show, in plain language, why a
// device isn't ringing while closed — the usual cause is an APK older than this
// feature, which is invisible otherwise.
const FCM_STATE_KEY = 'speedvox_fcm_state';

function fcmState() {
  try { return JSON.parse(localStorage.getItem(FCM_STATE_KEY)) || null; } catch { return null; }
}

function setFcmState(s) {
  const saved = Object.assign({}, s, { at: Date.now() });
  try { localStorage.setItem(FCM_STATE_KEY, JSON.stringify(saved)); } catch {}
  return saved;
}

// Only the last characters of the token are ever kept/shown: enough to tell two
// devices apart, useless to anyone who reads it.
function tokenTail(token) {
  return typeof token === 'string' && token.length > 6 ? token.slice(-6) : null;
}

async function setupNativeCallPush() {
  try {
    if (!isNative()) {
      return setFcmState({ ok: false, code: 'web',
        message: 'Disponível apenas no aplicativo Android (APK). No navegador a chamada só toca com o app aberto.' });
    }
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SpeedvoxCall;
    if (!plugin || !plugin.getToken) {
      return setFcmState({ ok: false, code: 'apk-antigo',
        message: 'Este APK é anterior à chamada com o app fechado. Instale a versão mais nova do SpeedVox para ativar.' });
    }

    let token = null;
    try {
      token = (await plugin.getToken()).token;
    } catch (e) {
      return setFcmState({ ok: false, code: 'sem-token',
        message: 'O Android não entregou o código de notificação deste aparelho. Confira se as notificações do SpeedVox estão permitidas e se há internet, depois toque em Ativar/Testar de novo.',
        detail: e && e.message });
    }
    if (!token) {
      return setFcmState({ ok: false, code: 'sem-token',
        message: 'O Android não entregou o código de notificação deste aparelho. Confira se as notificações do SpeedVox estão permitidas e se há internet, depois toque em Ativar/Testar de novo.' });
    }

    try {
      await api.registerFcm(token);
    } catch (e) {
      const expirou = e && e.status === 401;
      return setFcmState({ ok: false, code: 'servidor', tokenTail: tokenTail(token),
        message: expirou
          ? 'O aparelho gerou o código, mas a sessão expirou. Saia e entre de novo, depois toque em Ativar/Testar.'
          : 'O aparelho gerou o código, mas o servidor não confirmou o registro. Verifique a internet e tente de novo.',
        detail: e && e.message });
    }

    return setFcmState({ ok: true, code: 'ok', tokenTail: tokenTail(token),
      message: 'Este aparelho está registrado: chamadas tocam mesmo com o app fechado.' });
  } catch (e) {
    // Never let the diagnostic itself break startup; calls still work in foreground.
    return setFcmState({ ok: false, code: 'falha',
      message: 'Não foi possível verificar a chamada com o app fechado neste aparelho.',
      detail: e && e.message });
  }
}

// PWA installation: capture the browser's install event and offer a button.
function setupInstallPrompt() {
  let deferred = null;
  const show = () => {
    if (document.getElementById('install-app-btn')) return;
    const btn = el('button', { id: 'install-app-btn', class: 'install-app-btn' }, '⬇️ Instalar app');
    btn.onclick = async () => {
      if (!deferred) return;
      btn.disabled = true;
      deferred.prompt();
      try { await deferred.userChoice; } catch {}
      deferred = null;
      btn.remove();
    };
    document.body.append(btn);
  };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    show();
  });
  window.addEventListener('appinstalled', () => {
    const b = document.getElementById('install-app-btn');
    if (b) b.remove();
    toast('SpeedVox instalado!');
  });
}

async function boot() {
  // Bloqueio do app (PIN/digital) — se ativado, pede pra desbloquear antes
  // de mostrar qualquer coisa.
  await applock.guard();

  setupAuthScreen();
  checkVerifiedParam();

  // Pick up a token handed back by the Google OAuth callback.
  if (location.hash.startsWith('#token=')) {
    setToken(decodeURIComponent(location.hash.slice(7)));
    history.replaceState(null, '', location.pathname);
  }

  window.addEventListener('online', () => { state.online = true; updateNetIndicator(); });
  window.addEventListener('offline', () => { state.online = false; updateNetIndicator(); });

  // Unlock the audio engine on the first interaction so an incoming call rings
  // out loud (browsers keep audio suspended until the user touches the page).
  const unlockAudio = () => {
    ringtone.unlock();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  // PWA install affordance: when the browser deems the app installable, show an
  // "Instalar app" button so visitors can add it to the home screen.
  setupInstallPrompt();

  // Probe whether Google sign-in is configured to hide the button if not.
  try {
    // Point the Google button at the absolute server (so it isn't a 404 when the
    // app is loaded from local assets in the native build).
    const gbtn = $('#google-btn');
    if (gbtn) gbtn.href = apiUrl('/api/auth/google');
    const res = await fetch(apiUrl('/api/health'));
    const h = await res.json();
    if (!h.google) {
      $('#google-btn').classList.add('hidden');
      $('#google-disabled').classList.remove('hidden');
    }
  } catch {}

  if (getToken()) {
    let user = null;
    try {
      const r = await api.me();
      user = r.user;
    } catch (e) {
      if (e && e.status === 401) {
        // Token realmente inválido/expirado → aí sim sai de verdade.
        setToken(null);
        localStorage.removeItem('speedvox_me');
      } else {
        // Sem internet, erro passageiro ou volta da tela do Google: NÃO desloga.
        // Abre o app com o perfil salvo (modo offline) — essencial num apagão.
        try { user = JSON.parse(localStorage.getItem('speedvox_me')); } catch { user = null; }
      }
    }
    if (user) {
      try { await startApp(user); }
      catch (err) { console.warn('[boot] startApp falhou:', err && err.message); }
    }
  }

  // Open the right chat when a notification is tapped.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-chat' && e.data.chatId && state.chats.has(e.data.chatId)) {
        openChat(e.data.chatId);
      }
    });
  }
  const chatParam = new URLSearchParams(location.search).get('chat');
  if (chatParam) {
    history.replaceState(null, '', location.pathname);
    const tryOpen = setInterval(() => {
      if (state.chats.has(chatParam)) { clearInterval(tryOpen); openChat(chatParam); }
    }, 300);
    setTimeout(() => clearInterval(tryOpen), 6000);
  }
  // Public invite deep link: ?u=username opens a chat with that person.
  const userParam = new URLSearchParams(location.search).get('u');
  if (userParam && getToken()) {
    history.replaceState(null, '', location.pathname);
    setTimeout(() => openUserByUsername(userParam), 800);
  }

  if ('serviceWorker' in navigator) {
    // Auto-update: when a new version is deployed, the new service worker takes
    // over and we reload once so the user always runs the latest app (fixes the
    // "stale cached version" problem where new features didn't appear).
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return; // don't reload on the very first install
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.register('/service-worker.js').then((reg) => {
      // Check for a new version now and every time the app regains focus.
      reg.update().catch(() => {});
      window.addEventListener('focus', () => reg.update().catch(() => {}));
    }).catch(() => {});
  }
}

boot();

