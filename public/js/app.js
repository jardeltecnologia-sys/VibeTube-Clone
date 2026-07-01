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
import * as groupcrypto from './groupcrypto.js';
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
  serverReachable: false,
  lastHealthOkAt: 0,
  e2eeReady: false,
  keyCache: new Map(),    // chatId -> AES CryptoKey (or null if peer has no key)
  iceServers: null,
  composerMentions: new Map(), // displayName -> userId, for the current draft
  pendingAnswerCallId: null,
  ghostModeActive: false,
};
window.state = state;

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

// Ícones Lucide (SVG de traço, currentColor) — substituem emojis por um visual
// profissional e consistente. Uso: icon('trash'), icon('star', { fill: true }).
const ICON_PATHS = {
  reply: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  forward: '<polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V5a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  task: '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  'more-vertical': '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  ghost: '<path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  'bell-off': '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="1" y1="1" x2="23" y2="23"/>',
  'map-pin': '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.5 11.5 21 2m-4 4 2.5 2.5M14 9l2.5 2.5"/>',
};
function icon(name, { size = 20, fill = false } = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  return tpl.content.firstElementChild;
}

// Haptics — um "toque" tátil leve nos gestos principais (sensação premium, tipo
// iOS). Usa o plugin nativo do Capacitor quando existe (mais crisp); senão cai
// na Vibration API do WebView/navegador. Desligável em Ajustes.
function haptic(kind = 'light') {
  if (localStorage.getItem('speedvox_haptics') === '0') return;
  try {
    const H = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if (H && H.impact) {
      H.impact({ style: kind === 'medium' ? 'MEDIUM' : kind === 'heavy' ? 'HEAVY' : 'LIGHT' });
      return;
    }
    if (navigator.vibrate) navigator.vibrate(kind === 'medium' ? 16 : kind === 'heavy' ? 26 : 9);
  } catch { /* ignore */ }
}

const SERVER_REACHABLE_TTL_MS = 30000;
const HEALTH_TIMEOUT_MS = 3500;
let healthProbe = null;

function socketIsConnected() {
  return Boolean(state.socket && state.socket.connected);
}

function setServerReachable(ok) {
  state.serverReachable = Boolean(ok);
  if (ok) state.lastHealthOkAt = Date.now();
}

function cachedServerReachable() {
  return socketIsConnected()
    || (state.serverReachable && Date.now() - state.lastHealthOkAt < SERVER_REACHABLE_TTL_MS);
}

async function fetchServerHealth({ timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(apiUrl('/api/health'), {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json().catch(() => ({ ok: true }));
  } finally {
    clearTimeout(timer);
  }
}

async function isServerReachable({ force = false, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  if (socketIsConnected()) {
    setServerReachable(true);
    return true;
  }
  if (!force && cachedServerReachable()) return true;
  if (!force && healthProbe) return healthProbe;

  healthProbe = (async () => {
    try {
      const h = await fetchServerHealth({ timeoutMs });
      const ok = Boolean(h && h.ok);
      setServerReachable(ok);
      return ok;
    } catch {
      setServerReachable(false);
      return false;
    } finally {
      healthProbe = null;
      updateNetIndicator();
    }
  })();

  return healthProbe;
}

const hasInternetConnection = isServerReachable;

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

// Format a byte count as a human-readable string (KB, MB, GB).
function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// ── Premium in-app audio player ──────────────────────────────────────────────
// Replaces the default <audio controls> with a styled seekable player.
// Works with ALL audio formats the browser supports (mp3, aac, flac, wav, ogg,
// opus, m4a, webm, etc.) — the <audio> element handles codec negotiation.
function buildAudioPlayer(src, name) {
  const audio = el('audio', { src, preload: 'metadata' });
  const playBtn = el('button', { class: 'ap-play', title: 'Play / Pause' }, '▶');
  const timeEl  = el('span', { class: 'ap-time' }, '0:00');
  const durEl   = el('span', { class: 'ap-dur' }, '0:00');
  const track   = el('div', { class: 'ap-track' });
  const fill    = el('div', { class: 'ap-fill' });
  const knob    = el('div', { class: 'ap-knob' });
  const nameEl  = name ? el('div', { class: 'ap-name', title: name },
    name.length > 28 ? name.slice(0, 25) + '…' : name) : null;
  const speedBtn = el('button', { class: 'ap-speed' }, '1×');
  const speeds = [1, 1.25, 1.5, 2, 0.75];
  let speedIdx = 0;
  speedBtn.onclick = () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    audio.playbackRate = speeds[speedIdx];
    speedBtn.textContent = `${speeds[speedIdx]}×`;
  };

  track.append(fill, knob);

  audio.addEventListener('loadedmetadata', () => {
    durEl.textContent = fmtDuration(Math.round(audio.duration));
  });
  audio.addEventListener('timeupdate', () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    fill.style.width = `${pct}%`;
    knob.style.left   = `calc(${pct}% - 6px)`;
    timeEl.textContent = fmtDuration(Math.round(audio.currentTime));
  });
  audio.addEventListener('ended', () => { playBtn.textContent = '▶'; playBtn.classList.remove('playing'); });

  playBtn.onclick = () => {
    if (audio.paused) {
      // Pause all other active players first.
      document.querySelectorAll('.ap-audio-el').forEach(a => { if (a !== audio) { a.pause(); const b = a.closest('.msg-audio-player')?.querySelector('.ap-play'); if (b) { b.textContent = '▶'; b.classList.remove('playing'); } } });
      audio.play().catch(() => {});
      playBtn.textContent = '⏸';
      playBtn.classList.add('playing');
    } else {
      audio.pause();
      playBtn.textContent = '▶';
      playBtn.classList.remove('playing');
    }
  };

  // Seek by clicking/dragging the track.
  function seekTo(e) {
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (audio.duration) audio.currentTime = pct * audio.duration;
  }
  let dragging = false;
  track.addEventListener('mousedown', (e) => { dragging = true; seekTo(e); });
  track.addEventListener('touchstart', (e) => { dragging = true; seekTo(e.touches[0]); }, { passive: true });
  document.addEventListener('mousemove', (e) => { if (dragging) seekTo(e); });
  document.addEventListener('touchmove', (e) => { if (dragging) seekTo(e.touches[0]); }, { passive: true });
  document.addEventListener('mouseup', () => { dragging = false; });
  document.addEventListener('touchend', () => { dragging = false; });

  audio.className = 'ap-audio-el';

  const wrap = el('div', { class: 'msg-audio msg-audio-player' });
  const row1 = el('div', { class: 'ap-row' }, playBtn, timeEl, track, durEl, speedBtn);
  if (nameEl) wrap.append(nameEl);
  wrap.append(audio, row1);
  return wrap;
}

// ── Image lightbox ────────────────────────────────────────────────────────────
// Opens a fullscreen overlay with keyboard (←→ Esc) and touch-swipe support.
// Pass a single URL or an array of URLs + starting index for gallery mode.
function openLightbox(urlOrUrls, altText) {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
  let idx = 0;
  const overlay = el('div', { class: 'lightbox-overlay', id: 'lightbox-overlay' });
  const img     = el('img', { class: 'lightbox-img', src: urls[0], alt: altText || '' });
  const closeBtn = el('button', { class: 'lightbox-close', title: 'Fechar (Esc)' }, '✕');
  const prevBtn  = el('button', { class: 'lightbox-nav lightbox-prev', title: 'Anterior' }, '‹');
  const nextBtn  = el('button', { class: 'lightbox-nav lightbox-next', title: 'Próxima' }, '›');
  const counter  = el('span', { class: 'lightbox-counter' });

  function go(i) {
    idx = (i + urls.length) % urls.length;
    img.src = urls[idx];
    counter.textContent = urls.length > 1 ? `${idx + 1} / ${urls.length}` : '';
    prevBtn.style.display = urls.length > 1 ? '' : 'none';
    nextBtn.style.display = urls.length > 1 ? '' : 'none';
  }
  go(0);

  closeBtn.onclick = () => { overlay.classList.remove('open'); setTimeout(() => overlay.remove(), 250); document.removeEventListener('keydown', onKey); };
  prevBtn.onclick  = () => go(idx - 1);
  nextBtn.onclick  = () => go(idx + 1);
  overlay.onclick  = (e) => { if (e.target === overlay) closeBtn.onclick(); };

  function onKey(e) {
    if (e.key === 'Escape') closeBtn.onclick();
    if (e.key === 'ArrowLeft') go(idx - 1);
    if (e.key === 'ArrowRight') go(idx + 1);
  }
  document.addEventListener('keydown', onKey);

  // Touch swipe.
  let touchX = null;
  overlay.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener('touchend',   (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1));
    touchX = null;
  });

  overlay.append(img, closeBtn, prevBtn, nextBtn, counter);
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
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
  if (m.type === 'location') return '📍 Localização';
  if (m.type === 'contact') return '👤 Contato';
  if (m.type === 'event') return '📅 Evento';
  if (m.type === 'pix') return '💠 Pix';
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
async function connectSocket() {
  if (typeof io === 'undefined') {
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = apiUrl('/socket.io/socket.io.js');
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    } catch (err) {
      console.error('Failed to load Socket.IO client library, retrying in 5s...', err);
      setTimeout(connectSocket, 5000);
      return;
    }
  }

  // Same-origin for the web/PWA; absolute server URL for the bundled native app.
  // We omit forcing transports to allow auto-negotiation (polling -> websocket upgrade),
  // which prevents connection failures when websockets are blocked by Cloudflare or carriers.
  const socket = io(API_BASE || undefined, { auth: { token: getToken() } });
  state.socket = socket;

  socket.on('connect', () => {
    console.log('SOCKET_CONNECTED');
    setServerReachable(true);
    updateNetIndicator();
    flushOutbox();
    loadChats().then(() => syncActiveMessagesSoon()).catch(() => {});
    // Internet is back: keep the mesh device registry fresh (best-effort).
    offline.registerDevice().catch(() => {});
  });
  socket.on('disconnect', () => {
    console.log('SOCKET_DISCONNECTED');
    updateNetIndicator();
    hasInternetConnection({ force: true, timeoutMs: 2500 }).catch(() => {});
  });
  socket.on('connect_error', (e) => {
    if (e.message === 'unauthorized') logout();
    else hasInternetConnection({ force: true, timeoutMs: 2500 }).catch(() => {});
  });

  // E2EE de grupos (Sender Keys): recebo a sender key de um membro (cifrada
  // par-a-par) e guardo; ou me pedem a minha e eu reenvio.
  socket.on('group:senderkey', async ({ from, groupId, dist }) => {
    try {
      const pub = await getUserPublicKey(from);
      const key = pub ? await e2ee.deriveChatKey(pub) : null;
      if (!key) return;
      const distMsg = JSON.parse(await e2ee.decrypt(key, dist));
      saveJSON(grkKey(groupId, from), groupcrypto.receiverFromDistribution(distMsg));
      retryGroupDecrypt(groupId, from);
    } catch (err) { console.warn('group:senderkey recv falhou', err); }
  });
  socket.on('group:senderkey:request', ({ from, groupId }) => {
    const chat = state.chats.get(groupId);
    if (chat && chat.type === 'group') distributeSenderKeyTo(chat, from).catch(() => {});
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
    if (summary.id === state.activeChatId) {
      renderChatHeader(summary);
      const list = state.messages.get(summary.id) || [];
      const last = summary.lastMessage;
      if (last && !list.some((m) => m.id === last.id)) syncActiveMessagesSoon();
    }
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

  socket.on('message:ghost-burn', ({ messageId, chatId }) => {
    const list = state.messages.get(chatId);
    if (list) {
      const idx = list.findIndex((x) => x.id === messageId);
      if (idx !== -1) list.splice(idx, 1);
    }
    if (chatId === state.activeChatId) {
      const bubble = document.querySelector(`[data-mid="${messageId}"]`);
      if (bubble) {
        bubble.style.transition = 'opacity 0.8s ease-out, transform 0.8s ease-out';
        bubble.style.opacity = '0';
        bubble.style.transform = 'scale(0.8) translateY(-10px)';
        setTimeout(() => {
          renderMessages(true);
        }, 800);
      } else {
        renderMessages(true);
      }
    }
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

  socket.on('task:new', ({ chatId, task }) => {
    if (state.activeChatId === chatId) {
      toast(`📋 Nova tarefa: "${task.title}"`);
    }
  });

  socket.on('task:updated', ({ chatId, task }) => {
    if (state.activeChatId === chatId) {
      const status = task.completed ? 'concluída ✅' : 'reaberta';
      toast(`📋 Tarefa "${task.title}" foi ${status}`);
    }
  });

  socket.on('audio:transcribed', ({ messageId, chatId, transcription }) => {
    const list = state.messages.get(chatId);
    const m = list && list.find((x) => x.id === messageId);
    if (m) {
      m.transcription = transcription;
    }
    if (chatId === state.activeChatId) renderMessages(true);
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
    for (const [uid, p] of state.presence) if (p.online) state.mesh.connect(uid);
  }
  if (state.meshNearby && state.meshNearby.available) { try { await state.meshNearby.start(); } catch {} }
  const data = { name: state.me.displayName, text: 'Preciso de ajuda! (SOS)' };
  const coords = await new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => res({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => res(null), { timeout: 4000, maximumAge: 60000 });
  });
  if (coords) data.coords = coords;
  const count = state.mesh ? state.mesh.neighbors().length : 0;
  state.mesh.sos(data);
  toast(count
    ? `SOS enviado para ${count} aparelho(s) próximos`
    : 'SOS ativado — será entregue assim que houver aparelhos por perto');
}

function setupCalls() {
  state.calls = new CallManager({
    socket: state.socket,
    selfId: state.me.id,
    iceServers: state.iceServers,
    mesh: state.mesh, // lets a call be signaled over the mesh when the server is down
    self: { id: state.me.id, displayName: state.me.displayName, avatarUrl: state.me.avatarUrl },
  });
  // Deliver call signals that arrived over the mesh (blackout calling) to the
  // CallManager, exactly as if they'd come from the Socket.IO server.
  if (state.mesh) {
    state.mesh.addEventListener('callsignal', (ev) => state.calls.onMeshSignal(ev.detail));
  }
  state.groupCalls = new GroupCallManager({
    socket: state.socket,
    selfId: state.me.id,
    iceServers: state.iceServers,
    getUser: (uid) => {
      for (const c of state.chats.values()) {
        const m = (c.members || []).find((x) => x.id === uid);
        if (m) return m;
      }
      return { displayName: '' };
    },
  });
}

function startCall(media) {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;
  if (chat.type === 'group') {
    state.groupCalls.start(chat.id, media);
    return;
  }
  if (!chat.otherUser) return;
  state.calls.startCall(chat.otherUser, media);
}

// ------------------------------------------------------------------ encryption
// Resolve (and cache) the shared AES key for a direct chat. null = not encrypted.
async function ensureChatKey(chat) {
  if (!state.e2eeReady || !chat || chat.type !== 'direct' || !chat.otherUser) return null;
  if (state.keyCache.has(chat.id)) return state.keyCache.get(chat.id);
  let pub = chat.otherUser.publicKey;
  if (!pub) {
    try {
      const { user } = await api.getUser(chat.otherUser.id);
      pub = user.publicKey;
      chat.otherUser.publicKey = pub || null;
    } catch {}
  }
  const key = pub ? await e2ee.deriveChatKey(pub) : null;
  state.keyCache.set(chat.id, key);
  return key;
}

function chatIsEncrypted(chat) {
  return Boolean(chat && chat.type === 'direct' && state.keyCache.get(chat.id));
}

// ---- Double Ratchet sessions (forward secrecy) for direct chats ----
const ratchetLocks = new Map(); // chatId -> tail promise (serialize state mutations)
const ratchetKey = (chatId) => `speedvox_ratchet_${state.me.id}_${chatId}`;

function withRatchetLock(chatId, fn) {
  const prev = ratchetLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  ratchetLocks.set(chatId, next.catch(() => {}));
  return next;
}

async function loadRatchet(chat) {
  if (!state.e2eeReady || !chat || chat.type !== 'direct' || !chat.otherUser) return null;
  const raw = localStorage.getItem(ratchetKey(chat.id));
  if (raw) { try { return await ratchet.deserialize(raw); } catch { /* rebuild below */ } }
  let pk = chat.otherUser.publicKey;
  if (!pk) { try { const { user } = await api.getUser(chat.otherUser.id); pk = user.publicKey; chat.otherUser.publicKey = pk; } catch {} }
  if (!pk) return null;
  const bs = await e2ee.ratchetBootstrap(pk);
  if (!bs) return null;
  const st = bs.role === 'alice'
    ? await ratchet.initAlice(bs.sk, bs.peerPubRaw)
    : await ratchet.initBob(bs.sk, bs.myDH);
  localStorage.setItem(ratchetKey(chat.id), await ratchet.serialize(st));
  return st;
}

async function saveRatchet(chatId, st) {
  localStorage.setItem(ratchetKey(chatId), await ratchet.serialize(st));
}

async function resetChatCryptoSession(chat) {
  if (!chat || !chat.id) return;
  try { localStorage.removeItem(ratchetKey(chat.id)); } catch {}
  try { state.keyCache.delete(chat.id); } catch {}
  if (chat.otherUser && chat.otherUser.id) {
    try {
      const { user } = await api.getUser(chat.otherUser.id);
      chat.otherUser.publicKey = user.publicKey || null;
    } catch {}
  }
}

// Returns a v2 envelope string, or null if the ratchet cannot send yet.
function ratchetEncryptFor(chat, plaintext) {
  return withRatchetLock(chat.id, async () => {
    const st = await loadRatchet(chat);
    if (!st || !ratchet.canSend(st)) return null;
    const { header, ct } = await ratchet.ratchetEncrypt(st, plaintext);
    await saveRatchet(chat.id, st);
    return JSON.stringify({ v: 2, h: header, ct });
  });
}

// Returns plaintext, or null on failure.
function ratchetDecryptFor(chat, env) {
  return withRatchetLock(chat.id, async () => {
    const st = await loadRatchet(chat);
    if (!st) return null;
    const pt = await ratchet.ratchetDecrypt(st, env.h, env.ct);
    await saveRatchet(chat.id, st);
    return pt;
  });
}

// ============ Lote 3: E2EE de grupos (Sender Keys) ============
// Estado local: minha sender key por grupo; para quem já distribuí; e o estado
// de destinatário por (grupo, remetente). Nada disso sai em claro do aparelho.
const gskKey = (gid) => `speedvox_gsk_${state.me.id}_${gid}`;
const gskDistKey = (gid) => `speedvox_gskdist_${state.me.id}_${gid}`;
const grkKey = (gid, sid) => `speedvox_grk_${state.me.id}_${gid}_${sid}`;
const gLoad = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const gSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const saveJSON = gSave;

const _pubKeyCache = new Map();
async function getUserPublicKey(userId) {
  if (_pubKeyCache.has(userId)) return _pubKeyCache.get(userId);
  let pub = null;
  for (const chat of state.chats.values()) {
    const mem = (chat.members || []).find((x) => x.id === userId);
    if (mem && mem.publicKey) { pub = mem.publicKey; break; }
  }
  if (!pub) { try { const { user } = await api.getUser(userId); pub = user.publicKey || null; } catch {} }
  if (pub) _pubKeyCache.set(userId, pub);
  return pub;
}

async function getMySenderKey(groupId) {
  let sk = gLoad(gskKey(groupId));
  if (!sk) { sk = await groupcrypto.createSenderKey(); gSave(gskKey(groupId), sk); gSave(gskDistKey(groupId), []); }
  return sk;
}

// Envia minha distribution message a UM membro, cifrada par-a-par (só ele lê).
async function distributeSenderKeyTo(chat, memberId) {
  if (!chat || memberId === state.me.id) return false;
  const sk = await getMySenderKey(chat.id);
  const pub = await getUserPublicKey(memberId);
  if (!pub) return false;
  const key = await e2ee.deriveChatKey(pub);
  if (!key) return false;
  const encDist = JSON.stringify(await e2ee.encrypt(key, JSON.stringify(groupcrypto.distributionMessage(sk))));
  state.socket.emit('group:senderkey', { to: memberId, groupId: chat.id, dist: encDist });
  return true;
}

// Garante que todos os membros atuais tenham a minha sender key.
async function ensureSenderKeyDistributed(chat) {
  await getMySenderKey(chat.id);
  const done = new Set(gLoad(gskDistKey(chat.id)) || []);
  for (const m of (chat.members || [])) {
    if (m.id === state.me.id || done.has(m.id)) continue;
    if (await distributeSenderKeyTo(chat, m.id)) done.add(m.id);
  }
  gSave(gskDistKey(chat.id), [...done]);
}

async function groupEncryptFor(chat, plaintext) {
  if (!state.e2eeReady) return null;
  await ensureSenderKeyDistributed(chat);
  const sk = await getMySenderKey(chat.id);
  const { env, sender } = await groupcrypto.senderEncrypt(sk, plaintext);
  gSave(gskKey(chat.id), sender);
  return JSON.stringify(env);
}

async function groupDecryptFor(groupId, senderId, env) {
  const recv = gLoad(grkKey(groupId, senderId));
  if (!recv) return null; // ainda não tenho a sender key desse remetente
  const { plaintext, recv: newRecv } = await groupcrypto.receiverDecrypt(recv, env);
  gSave(grkKey(groupId, senderId), newRecv);
  return plaintext;
}

const _skReqAt = new Map();
function requestSenderKey(groupId, senderId) {
  if (!senderId || senderId === state.me.id) return;
  const k = `${groupId}|${senderId}`;
  const now = Date.now();
  if (_skReqAt.get(k) && now - _skReqAt.get(k) < 8000) return; // debounce
  _skReqAt.set(k, now);
  try { state.socket.emit('group:senderkey:request', { to: senderId, groupId }); } catch {}
}

function retryGroupDecrypt(groupId, senderId) {
  const list = state.messages.get(groupId) || [];
  for (const m of list) {
    if (m.senderId === senderId && m.encrypted && m._decryptFailed) {
      m._decryptFailed = false; m._plain = null; decryptInto(m);
    }
  }
}

// Decrypt an incoming encrypted message in place, then refresh the views.
async function decryptInto(m) {
  const chat = state.chats.get(m.chatId);
  let env = null;
  try { env = JSON.parse(m.body); } catch {}
  try {
    let pt = null;
    if (env && env.gk === 1) {
      // Mensagem de GRUPO (Sender Keys). Se ainda não tenho a chave do
      // remetente, peço e mostro "decifrando" até ela chegar.
      pt = await groupDecryptFor(m.chatId, m.senderId, env);
      if (pt == null) requestSenderKey(m.chatId, m.senderId);
    } else if (env && env.v === 2) {
      // Forward-secret (Double Ratchet) message (chat direto).
      pt = await ratchetDecryptFor(chat, env);
    } else {
      // Legacy/static AES message (also used for edits/forwards).
      const key = await ensureChatKey(chat);
      pt = key ? await e2ee.decrypt(key, m.body) : null;
    }
    if (pt == null) { m._decryptFailed = true; }
    else { applyDecryptedPlain(m, pt); m._decryptFailed = false; }
  } catch { m._decryptFailed = true; }
  if (m.chatId === state.activeChatId) renderMessages(true);
  renderChatList();
}

// Trata o texto decifrado. Para mídia E2EE (Lote 2), o "plaintext" é um envelope
// JSON com a chave do arquivo (mk/iv) + nome/mime + legenda — não é texto visível.
function applyDecryptedPlain(m, pt) {
  if (['image', 'video', 'audio', 'file'].includes(m.type)) {
    try {
      const mv = JSON.parse(pt);
      if (mv && mv.mk && mv.iv) {
        m._mediaKeyB64 = mv.mk;
        m._mediaIvB64 = mv.iv;
        m._mediaEncrypted = true;
        if (mv.name && !m.mediaName) m.mediaName = mv.name;
        if (mv.mime && !m.mediaMime) m.mediaMime = mv.mime;
        m._plain = mv.caption || '';
        return;
      }
    } catch { /* não é envelope de mídia — trata como texto */ }
  }
  m._plain = pt;
}

// ---------------------------------------------- Lote 2: E2EE de mídia (anexos)
// Cifra os BYTES do arquivo com uma chave aleatória por mídia; o servidor guarda
// só o blob cifrado. A chave viaja no corpo E2EE da mensagem. Mídia antiga (sem
// cifra) segue abrindo normalmente — mudança aditiva.
function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function encryptFileBytes(file) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await file.arrayBuffer();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const encFile = new File([ct], (file.name || 'media') + '.enc', { type: 'application/octet-stream' });
  return { encFile, mk: bytesToB64(rawKey), iv: bytesToB64(iv) };
}

// Baixa o blob cifrado e devolve um objectURL já decifrado para exibir.
async function decryptMediaToUrl(m) {
  const rawKey = b64ToBytes(m._mediaKeyB64);
  const iv = b64ToBytes(m._mediaIvB64);
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const res = await fetch(mediaUrl(m.mediaUrl));
  if (!res.ok) throw new Error('fetch falhou');
  const ct = await res.arrayBuffer();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const blob = new Blob([pt], { type: m.mediaMime || 'application/octet-stream' });
  return URL.createObjectURL(blob);
}

// Plaintext to display for a message (handles encrypted bodies).
function displayText(m) {
  if (!m.encrypted) return m.body;
  if (m._plain != null) return m._plain;
  return null; // not yet decrypted (or failed)
}

// ---------------------------------------------------- identity verification
// "Número de segurança" (safety number), estilo Signal: um valor derivado das
// DUAS chaves de identidade. Se o servidor trocar a chave de alguém (ataque de
// intermediário), o número muda — e os dois lados percebem ao comparar.
async function jwkPubToRaw(jwkStr) {
  const jwk = typeof jwkStr === 'string' ? JSON.parse(jwkStr) : jwkStr;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

async function computeSafetyNumber(myPubStr, theirPubStr) {
  const a = await jwkPubToRaw(myPubStr);
  const b = await jwkPubToRaw(theirPubStr);
  // Ordem independente: ordena as duas chaves cruas para os dois lados obterem
  // exatamente o mesmo número.
  const cmp = (x, y) => { const n = Math.min(x.length, y.length); for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
  const [first, second] = cmp(a, b) <= 0 ? [a, b] : [b, a];
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0); combined.set(second, first.length);
  // Alonga o cálculo um pouco (defesa em profundidade) e converte em dígitos.
  let h = new Uint8Array(await crypto.subtle.digest('SHA-256', combined));
  for (let i = 0; i < 4999; i++) h = new Uint8Array(await crypto.subtle.digest('SHA-256', h));
  let digits = '';
  let src = h;
  while (digits.length < 60) {
    for (const byte of src) { digits += (byte % 10); if (digits.length >= 60) break; }
    if (digits.length < 60) src = new Uint8Array(await crypto.subtle.digest('SHA-256', src));
  }
  return digits.slice(0, 60).replace(/(\d{5})(?=\d)/g, '$1 ');
}

async function openSafetyNumber(chat) {
  const mine = e2ee.myPublicKey();
  let theirs = chat.otherUser && chat.otherUser.publicKey;
  if (!theirs && chat.otherUser) {
    try { const { user } = await api.getUser(chat.otherUser.id); theirs = user.publicKey; chat.otherUser.publicKey = theirs || null; } catch {}
  }
  if (!mine || !theirs) { toast('Ainda não há chaves de criptografia para este contato'); return; }

  let number;
  try { number = await computeSafetyNumber(mine, theirs); }
  catch { toast('Não foi possível calcular o número de segurança'); return; }

  const vkey = `speedvox_verified_${chat.otherUser.id}`;
  const statusLine = el('div', { class: 'auth-hint', style: 'margin:0;text-align:center' });
  const toggle = el('button', { class: 'btn-primary', style: 'margin-top:8px' });
  const refresh = () => {
    const v = localStorage.getItem(vkey);
    if (v === number) statusLine.textContent = '✅ Verificado — a identidade confere.';
    else if (v) statusLine.textContent = '⚠️ A chave mudou desde a verificação! Confirme com o contato por outro meio.';
    else statusLine.textContent = 'Ainda não verificado. Compare os dígitos abaixo com os do contato.';
    toggle.textContent = v === number ? 'Remover verificação' : 'Marcar como verificado';
  };
  toggle.onclick = () => {
    if (localStorage.getItem(vkey) === number) localStorage.removeItem(vkey);
    else localStorage.setItem(vkey, number);
    refresh();
  };
  refresh();

  const qr = el('div', { style: 'display:flex;justify-content:center;margin:12px 0' });
  try { qr.innerHTML = qrSVG(`speedvox-sn:${number.replace(/ /g, '')}`, { size: 200, margin: 4 }); } catch {}

  const body = el('div', { class: 'modal-body' },
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      `Compare estes 60 dígitos (ou o QR) com os que ${chat.otherUser.displayName} vê no aparelho dele. Se forem idênticos, ninguém está no meio da conversa.`),
    qr,
    el('div', { style: 'font-family:monospace;font-size:18px;letter-spacing:1px;line-height:1.9;text-align:center;word-break:break-word' }, number),
    el('div', { style: 'margin-top:12px' }, statusLine),
    toggle);
  modalShell('🔐 Número de segurança', body);
}

// ------------------------------------------------------------------ data load
async function loadChats() {
  try {
    const { chats } = await api.listChats();
    state.chats.clear();
    for (const c of chats) state.chats.set(c.id, c);
    try { localStorage.setItem('speedvox_chats', JSON.stringify(chats)); } catch { /* storage cheio */ }
  } catch (e) {
    // Sem internet (apagão): mostra as conversas salvas da última vez, pra o app
    // abrir mesmo offline. A rede mesh segue funcionando independente disso.
    let cached = [];
    try { cached = JSON.parse(localStorage.getItem('speedvox_chats')) || []; } catch { cached = []; }
    state.chats.clear();
    for (const c of cached) state.chats.set(c.id, c);
  }
  renderChatList();
}

async function openChat(chatId) {
  state.activeChatId = chatId;
  state.replyTo = null;
  state.ghostModeActive = false;
  updateComposerPlaceholder();
  hideComposerPreview();
  clearTimeout(composerPreviewTimer);
  composerPreviewTimer = null;
  state.composerMentions.clear();
  $('#mention-suggest').classList.add('hidden');
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
  for (const m of messages) if (m.encrypted && m._plain == null) decryptInto(m);
  renderMessages(silent);
}

function syncActiveMessagesSoon() {
  if (!state.activeChatId) return;
  clearTimeout(syncActiveMessagesSoon._timer);
  syncActiveMessagesSoon._timer = setTimeout(() => {
    reloadActiveMessages(true).catch(() => {});
  }, 200);
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
    onclick: (e) => { e.stopPropagation(); openChatMenu(e.currentTarget, chat); } }, icon('more-vertical', { size: 18 }));

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

const FOLDERS = [['all', 'Todas'], ['unread', 'Não lidas'], ['groups', 'Grupos'], ['direct', 'Diretas'], ['status', 'Status']];
function renderFolderTabs() {
  const bar = $('#folder-tabs');
  if (!bar) return;
  const current = state.chatFolder || 'all';
  bar.innerHTML = '';
  for (const [key, label] of FOLDERS) {
    const tab = el('button', { class: 'folder-tab' + (key === current ? ' active' : ''),
      onclick: () => { state.chatFolder = key; renderChatList(); } }, label);
    bar.append(tab);
  }
}

function renderChatList() {
  const filter = $('#chat-search').value.trim().toLowerCase();
  const list = $('#chat-list');
  list.innerHTML = '';

  const folder = state.chatFolder || 'all';
  if (folder === 'status') {
    renderStatusList();
    return;
  }

  const all = [...state.chats.values()].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const at = a.lastMessage ? a.lastMessage.createdAt : 0;
    const bt = b.lastMessage ? b.lastMessage.createdAt : 0;
    return bt - at;
  });
  const visible = all.filter((c) => (!filter || c.title.toLowerCase().includes(filter)));
  const archived = visible.filter((c) => c.archived);
  let active = visible.filter((c) => !c.archived);
  // Chat folders (Telegram-style filters).
  if (folder === 'unread') active = active.filter((c) => c.unread > 0);
  else if (folder === 'groups') active = active.filter((c) => c.type === 'group');
  else if (folder === 'direct') active = active.filter((c) => c.type !== 'group');
  renderFolderTabs();

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
  const item = (iconName, label, fn) => el('div', { class: 'popup-item', onclick: async (e) => {
    e.stopPropagation(); menu.remove(); await fn();
  } }, icon(iconName, { size: 18 }), el('span', {}, label));

  menu.append(item('pin', chat.pinned ? 'Desafixar' : 'Fixar', () => api.pinChat(chat.id, !chat.pinned).then(applyChatPatch)));
  menu.append(item('archive', chat.archived ? 'Desarquivar' : 'Arquivar', () => api.archiveChat(chat.id, !chat.archived).then(applyChatPatch)));
  menu.append(item(chat.muted ? 'bell' : 'bell-off', chat.muted ? 'Reativar som' : 'Silenciar 8h', () =>
    api.muteChat(chat.id, chat.muted ? 0 : Date.now() + 8 * 3600 * 1000).then(applyChatPatch)));
  menu.append(item('clock', `Mensagens temporárias${chat.disappearingTimer ? ' (ativas)' : ''}`, () => quickDisappearing(chat)));

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
  $('#chat-header-actions').style.display = 'flex'; // 1:1 and group calls supported
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
  updateComposerState(chat);
  renderPinnedBar(chat);
}

function renderTyping() {
  const chat = state.chats.get(state.activeChatId);
  if (chat) renderChatHeader(chat);
}

// Show the block banner instead of the composer when I have blocked this contact.
function updateComposerState(chat) {
  const blocked = Boolean(chat && chat.blocked);
  $('#composer').classList.toggle('hidden', blocked);
  $('#block-banner').classList.toggle('hidden', !blocked);
}

// A call-log entry shown inline in the conversation (like WhatsApp).
function callMessageNode(m) {
  const c = parseCall(m);
  const missed = c.status === 'missed' || c.status === 'rejected' || c.status === 'canceled';
  const chat = state.chats.get(m.chatId);
  const callBack = el('button', { class: 'call-log-btn', title: 'Ligar de volta',
    onclick: () => { if (chat && chat.otherUser) state.calls.startCall(chat.otherUser, c.media); } },
    icon(c.media === 'video' ? 'video' : 'phone', { size: 17 }));
  const mine = m.senderId === state.me.id;
  const dir = mine ? '↗' : '↙'; // feita / recebida
  return el('div', { class: `call-log${missed ? ' missed' : ''}` },
    el('span', { class: 'call-log-icon' }, c.media === 'video' ? '🎥' : '📞'),
    el('span', { class: 'call-log-text' },
      el('span', { class: 'call-log-dir' }, dir + ' '), callLabel(m)),
    el('span', { class: 'call-log-time' }, fmtTime(m.createdAt)),
    callBack);
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
  // Banner de segurança: aparece no topo das conversas com criptografia de
  // ponta a ponta (deixa claro que ninguém de fora consegue ler).
  if (chatIsEncrypted(chat)) {
    container.append(el('div', { class: 'e2ee-banner' },
      el('span', { class: 'lock' }, '🔒'),
      'As mensagens desta conversa são protegidas com criptografia de ponta a ponta. Ninguém fora dela consegue ler — nem o SpeedVox.'));
  }
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
    if (m.type === 'call') {
      container.append(callMessageNode(m));
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
      const srcUrl = m._decryptedUrl || m._localMediaUrl || (m.mediaUrl ? mediaUrl(m.mediaUrl) : null);
      const isMediaMsg = ['image', 'video', 'audio', 'file'].includes(m.type);
      if (m.encrypted && isMediaMsg && m._decryptFailed) {
        // Não conseguimos a chave (corpo E2EE) — não tente abrir o blob cifrado.
        parts.push(el('div', { class: 'msg-media' }, '🔒 Mídia cifrada — não foi possível abrir'));
      } else if (m._mediaEncrypted && !m._decryptedUrl) {
        // Descriptografa o blob e re-renderiza quando pronto.
        if (!m._mediaDecrypting && !m._mediaDecryptFailed) {
          m._mediaDecrypting = true;
          decryptMediaToUrl(m)
            .then((u) => { m._decryptedUrl = u; m._mediaDecrypting = false; if (m.chatId === state.activeChatId) renderMessages(true); })
            .catch(() => { m._mediaDecryptFailed = true; m._mediaDecrypting = false; if (m.chatId === state.activeChatId) renderMessages(true); });
        }
        parts.push(el('div', { class: 'msg-media' },
          m._mediaDecryptFailed ? '🔒 Mídia cifrada — não foi possível abrir' : '🔒 Descriptografando…'));
      } else if (m.type === 'image' && m.mediaUrl) {
        const mu = srcUrl;
        const ext = (m.mediaName || m.mediaUrl || '').split('.').pop().toLowerCase();
        // SVG and some rare formats browsers may not display inline — open in new tab.
        const openable = !['svg','bmp','tiff','tif','raw','jxl'].includes(ext);
        const showImg = () => {
          const img = el('img', {
            src: mu, loading: 'lazy', class: 'msg-img',
            onclick: () => openable ? openLightbox(mu, m.mediaName) : window.open(mu, '_blank'),
          });
          return img;
        };
        if (autoDownloadOn()) {
          parts.push(el('div', { class: 'msg-media' }, showImg()));
        } else {
          const wrap = el('div', { class: 'msg-media' });
          const btn = el('button', { class: 'media-download-btn',
            onclick: () => { wrap.innerHTML = ''; wrap.append(showImg()); } },
            '⬇ Baixar foto');
          wrap.append(btn);
          parts.push(wrap);
        }
      } else if (m.type === 'video' && m.mediaUrl) {
        const vu = srcUrl;
        const showVid = () => el('video', { class: 'msg-video', src: vu, controls: '',
          preload: 'metadata', playsinline: '' });
        if (autoDownloadOn()) {
          parts.push(el('div', { class: 'msg-media' }, showVid()));
        } else {
          const wrap = el('div', { class: 'msg-media' });
          const btn = el('button', { class: 'media-download-btn',
            onclick: () => { wrap.innerHTML = ''; wrap.append(showVid()); } },
            '▶ Carregar vídeo');
          wrap.append(btn);
          parts.push(wrap);
        }
      } else if (m.type === 'audio' && m.mediaUrl) {
        const src = srcUrl;
        const audioNode = buildAudioPlayer(src, m.mediaName);
        if (m.transcription) {
          const transWrap = el('div', { class: 'msg-audio-transcription', style: 'margin-top: 8px; font-size: 13px; border-top: 1px dashed var(--border); padding-top: 8px;' });
          const toggleBtn = el('button', {
            style: 'background: none; border: none; color: var(--accent); cursor: pointer; padding: 0; font-size: 11px; display: flex; align-items: center; gap: 4px; margin-bottom: 6px; font-weight: bold;',
            onclick: () => {
              contentWrap.classList.toggle('hidden');
              toggleBtn.textContent = contentWrap.classList.contains('hidden') ? '📝 Ver Transcrição e Resumo' : '📖 Ocultar Transcrição';
            }
          }, '📝 Ver Transcrição e Resumo');
          const contentWrap = el('div', { class: 'hidden', style: 'display: flex; flex-direction: column; gap: 6px;' });
          contentWrap.append(
            el('div', { style: 'font-style: italic; color: var(--text-2); line-height: 1.4;' }, `"${m.transcription.transcript}"`),
            el('div', { style: 'background: var(--panel-3); padding: 8px; border-radius: 8px; font-size: 12px; line-height: 1.4; color: var(--text-1); border-left: 3px solid var(--accent); white-space: pre-wrap;' }, m.transcription.summary)
          );
          transWrap.append(toggleBtn, contentWrap);
          audioNode.append(transWrap);
        }
        parts.push(audioNode);
      } else if (m.type === 'file' && m.mediaUrl) {
        const ic = fileIcon(m.mediaName, m.mediaMime);
        const sizeStr = m.mediaSize ? formatBytes(m.mediaSize) : '';
        parts.push(el('a', {
          class: 'msg-file', href: srcUrl, target: '_blank',
          download: m.mediaName || '',
        },
          el('span', { class: 'file-ic' }, ic),
          el('div', { class: 'file-info' },
            el('span', { class: 'file-name' }, m.mediaName || 'Arquivo'),
            sizeStr ? el('span', { class: 'file-size' }, sizeStr) : ''
          ),
          el('span', { class: 'file-dl', title: 'Baixar' }, '⬇')
        ));
      } else if (m.type === 'poll' && m.poll) {
        parts.push(pollNode(m));
      } else if (m.type === 'location') {
        parts.push(locationNode(m));
      } else if (m.type === 'contact') {
        parts.push(contactCardNode(m));
      } else if (m.type === 'event') {
        parts.push(eventNode(m));
      } else if (m.type === 'pix') {
        parts.push(pixNode(m));
      }
      const CARD_TYPES = ['poll', 'location', 'contact', 'event', 'pix'];
      const text = CARD_TYPES.includes(m.type) ? null : displayText(m);
      if (m.encrypted && text == null && !CARD_TYPES.includes(m.type)) {
        parts.push(el('div', { class: 'msg-body msg-encrypted' },
          m._decryptFailed ? '🔒 Não foi possível decifrar' : '🔒 Decifrando…'));
      } else if (text) {
        parts.push(bodyNode(text, m, chat));
        // Prévia de link (notícias etc.) — só pro primeiro link da mensagem.
        const url = firstUrl(text);
        if (url) { const card = linkPreviewNode(url); if (card) parts.push(card); }
      }
    }

    if (m._timerInterval) {
      clearInterval(m._timerInterval);
      m._timerInterval = null;
    }

    let ghostTimerEl = null;
    if (m.ghostTtl && m.ghostTtl > 0 && !m.deleted) {
      const isRead = !mine || (m.readBy && m.readBy.length > 0);
      ghostTimerEl = el('span', { class: 'ghost-timer', style: 'margin-right: 6px; font-weight: bold; color: var(--accent); cursor: default;' });
      
      if (isRead) {
        if (!m._readAt) m._readAt = Date.now();
        const elapsed = (Date.now() - m._readAt) / 1000;
        const remaining = Math.max(0, m.ghostTtl - elapsed);
        
        let secondsLeft = Math.ceil(remaining);
        ghostTimerEl.textContent = `👻 ${secondsLeft}s`;
        
        const interval = setInterval(() => {
          secondsLeft--;
          if (secondsLeft <= 0) {
            clearInterval(interval);
            ghostTimerEl.textContent = `👻 0s`;
            const bubble = container.querySelector(`[data-mid="${m.id}"]`);
            if (bubble) {
              bubble.style.transition = 'opacity 0.8s ease-out, transform 0.8s ease-out';
              bubble.style.opacity = '0';
              bubble.style.transform = 'scale(0.8) translateY(-10px)';
            }
          } else {
            ghostTimerEl.textContent = `👻 ${secondsLeft}s`;
          }
        }, 1000);
        m._timerInterval = interval;
      } else {
        ghostTimerEl.textContent = '👻';
        ghostTimerEl.title = 'Mensagem fantasma (aguardando leitura)';
      }
    }

    const meta = el('div', { class: 'msg-meta' },
      ghostTimerEl || '',
      m.starred && !m.deleted ? el('span', { class: 'star-label', title: 'Favorita' }, '★') : '',
      m.editedAt && !m.deleted ? el('span', { class: 'edited-label' }, 'editada') : '',
      fmtTime(m.createdAt),
      mine && !m.deleted ? tickFor(m, chat) : '');
    parts.push(meta);

    if (m.reactions && m.reactions.length) {
      const counts = new Map();
      for (const r of m.reactions) counts.set(r.emoji, (counts.get(r.emoji) || 0) + 1);
      const mineEmoji = (m.reactions.find((r) => r.user_id === state.me.id) || {}).emoji;
      const label = [...counts.entries()].map(([e, n]) => `${e}${n > 1 ? n : ''}`).join(' ');
      parts.push(el('div', {
        class: `msg-reactions${mineEmoji ? ' mine' : ''}`,
        title: 'Alterar reação',
        onclick: (e) => { e.stopPropagation(); openReactionPicker(e.currentTarget, m); },
      }, label));
    }

    const myRole = (chat.members.find((x) => x.id === state.me.id) || {}).role;
    const canPin = !m.deleted && (chat.type === 'direct' || myRole === 'admin');
    const actions = el('div', { class: 'msg-actions' },
      m.deleted ? '' : el('button', { title: 'Responder', onclick: () => setReply(m) }, icon('reply')),
      m.deleted ? '' : el('button', { title: 'Reagir', onclick: (e) => openReactionPicker(e.currentTarget, m) }, icon('smile')),
      m.deleted ? '' : el('button', { title: m.starred ? 'Desfavoritar' : 'Favoritar', onclick: () => toggleStar(m) }, icon('star', { fill: m.starred })),
      m.deleted ? '' : el('button', { title: 'Encaminhar', onclick: () => forwardMessage(m) }, icon('forward')),
      canPin ? el('button', { title: 'Fixar', onclick: () => pinMessage(m) }, icon('pin')) : '',
      m.deleted ? '' : el('button', { title: 'Criar Tarefa', onclick: () => createTaskFromMessage(m) }, icon('task')),
      mine && !m.deleted && m.type === 'text'
        ? el('button', { title: 'Editar', onclick: () => startEdit(m) }, icon('edit')) : '',
      mine && !m.deleted ? el('button', { title: 'Apagar', onclick: () => deleteMessage(m) }, icon('trash')) : '');
    parts.push(actions);

    container.append(el('div', { class: `msg ${mine ? 'out' : 'in'}`, 'data-mid': m.id }, ...parts));
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
function react(m, emoji) { haptic('light'); state.socket.emit('message:react', { messageId: m.id, emoji }); }
function deleteMessage(m) {
  if (confirm('Apagar esta mensagem para todos?')) state.socket.emit('message:delete', { messageId: m.id });
}

async function toggleStar(m) {
  haptic('light');
  try {
    const { starred } = await api.starMessage(m.id, !m.starred);
    m.starred = starred;
    renderMessages(true);
  } catch (e) { toast('Falha ao favoritar'); }
}

async function pinMessage(m) {
  try {
    const { chat } = await api.pinMessage(m.chatId, m.id);
    state.chats.set(chat.id, chat);
    renderPinnedBar(chat);
    toast('Mensagem fixada');
  } catch (e) { toast(e.message || 'Falha ao fixar'); }
}

async function unpinMessage(chatId) {
  try {
    const { chat } = await api.pinMessage(chatId, null);
    state.chats.set(chat.id, chat);
    renderPinnedBar(chat);
  } catch (e) { toast(e.message || 'Falha ao desafixar'); }
}

// Build a message-body node, highlighting @mentions in group chats.
const URL_RE = /https?:\/\/[^\s<]+/gi;

// O primeiro link http(s) de um texto (sem pontuação final colada).
function firstUrl(text) {
  const m = String(text || '').match(URL_RE);
  return m ? m[0].replace(/[.,;:)\]]+$/, '') : null;
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Corpo da mensagem: destaca @menções (em grupos) e transforma URLs em links
// clicáveis.
function bodyNode(text, m, chat) {
  const node = el('div', { class: 'msg-body' });
  const str = String(text);
  let last = 0; let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(str)) !== null) {
    if (match.index > last) appendWithMentions(node, str.slice(last, match.index), m, chat);
    const url = match[0].replace(/[.,;:)\]]+$/, '');
    node.append(el('a', { class: 'msg-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = match.index + url.length;
    URL_RE.lastIndex = last;
  }
  if (last < str.length) appendWithMentions(node, str.slice(last), m, chat);
  return node;
}

// Acrescenta um trecho de texto ao nó, destacando @menções quando houver.
function appendWithMentions(node, text, m, chat) {
  if (chat.type !== 'group' || !m.mentions || !m.mentions.length) {
    node.append(document.createTextNode(text));
    return;
  }
  const names = m.mentions
    .map((uid) => (chat.members.find((x) => x.id === uid) || {}).displayName)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length); // longest first to avoid partial overlaps
  if (!names.length) { node.append(document.createTextNode(text)); return; }
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`@(${esc})`, 'g');
  let last = 0; let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) node.append(document.createTextNode(text.slice(last, match.index)));
    node.append(el('span', { class: 'mention' }, match[0]));
    last = match.index + match[0].length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

// Cache de prévias de link (evita rebuscar a cada re-render). url -> data|null.
const linkPreviewCache = new Map();
const linkPreviewInflight = new Set();

function previewCardFrom(url, d) {
  const card = el('a', { class: 'link-preview', href: url, target: '_blank', rel: 'noopener noreferrer' });
  if (d.image) {
    card.append(el('img', { src: d.image, loading: 'lazy',
      onerror: function () { this.remove(); } }));
  }
  const body = el('div', { class: 'link-preview-body' });
  body.append(el('div', { class: 'link-preview-site' }, d.site || hostOf(url)));
  if (d.title) body.append(el('div', { class: 'link-preview-title' }, d.title));
  if (d.description) body.append(el('div', { class: 'link-preview-desc' }, d.description));
  card.append(body);
  return card;
}

// Cartão de prévia do link. Retorna null quando já se sabe que não há prévia.
function linkPreviewNode(url) {
  if (linkPreviewCache.has(url)) {
    const d = linkPreviewCache.get(url);
    return d ? previewCardFrom(url, d) : null;
  }
  const card = el('a', { class: 'link-preview', href: url, target: '_blank', rel: 'noopener noreferrer' },
    el('div', { class: 'link-preview-loading' }, '🔗 Carregando prévia do link…'));
  if (!linkPreviewInflight.has(url)) {
    linkPreviewInflight.add(url);
    api.linkPreview(url)
      .then((d) => {
        const ok = d && (d.title || d.image);
        linkPreviewCache.set(url, ok ? d : null);
        linkPreviewInflight.delete(url);
        if (state.activeChatId) renderMessages(true);
      })
      .catch(() => { linkPreviewCache.set(url, null); linkPreviewInflight.delete(url); });
  }
  return card;
}

// The pinned-message bar above the conversation.
function renderPinnedBar(chat) {
  const bar = $('#pinned-bar');
  if (!chat || !chat.pinnedMessage) { bar.classList.add('hidden'); return; }
  const pm = chat.pinnedMessage;
  bar.classList.remove('hidden');
  bar.innerHTML = '';
  const sender = (chat.members || []).find((x) => x.id === pm.senderId);
  bar.append(
    el('span', { class: 'pinned-icon' }, '📌'),
    el('div', { class: 'pinned-body', onclick: () => scrollToMessage(pm.id) },
      el('span', { class: 'pinned-label' }, 'Mensagem fixada'),
      el('span', { class: 'pinned-text' }, (sender ? sender.displayName + ': ' : '') + (pm.encrypted ? '🔒 mensagem' : lastMessagePreview(pm)))),
    el('button', { class: 'icon-btn', title: 'Desafixar', onclick: () => unpinMessage(chat.id) }, '✕'));
}

function scrollToMessage(messageId) {
  const node = document.querySelector(`[data-mid="${messageId}"]`);
  if (node) { node.scrollIntoView({ behavior: 'smooth', block: 'center' }); node.classList.add('flash'); setTimeout(() => node.classList.remove('flash'), 1200); }
}

// Quick reaction set (like WhatsApp) and a larger set for the composer picker.
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJI_SET = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤩', '🥳',
  '😉', '🙂', '😇', '🤔', '😴', '😭', '😢', '😡', '🥺', '😱',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '👌', '✌️', '🤞', '🔥',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '✨',
  '🎉', '🎈', '🎁', '🥂', '☕', '🍕', '⚽', '🚀', '🌟', '😅',
];

// Generic emoji popup anchored to an element. onPick receives the chosen emoji.
function openEmojiPopup(anchor, emojis, onPick) {
  document.querySelector('.emoji-popup')?.remove();
  const popup = el('div', { class: 'emoji-popup' });
  for (const e of emojis) {
    popup.append(el('button', { class: 'emoji-opt', onclick: (ev) => {
      ev.stopPropagation(); popup.remove(); onPick(e);
    } }, e));
  }
  document.body.append(popup);
  const r = anchor.getBoundingClientRect();
  popup.style.top = `${Math.max(8, r.top - popup.offsetHeight - 6)}px`;
  popup.style.left = `${Math.min(Math.max(8, r.left - 40), window.innerWidth - popup.offsetWidth - 8)}px`;
  const close = (ev) => { if (!popup.contains(ev.target)) { popup.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function openReactionPicker(anchor, m) {
  openEmojiPopup(anchor, QUICK_REACTIONS, (emoji) => react(m, emoji));
}

// @mention autocomplete (group chats).
function updateMentionSuggest() {
  const box = $('#mention-suggest');
  const chat = state.chats.get(state.activeChatId);
  if (!chat || chat.type !== 'group') { box.classList.add('hidden'); return; }
  const input = $('#message-input');
  const upto = input.value.slice(0, input.selectionStart);
  const match = upto.match(/(?:^|\s)@([\w.]*)$/);
  if (!match) { box.classList.add('hidden'); return; }
  const q = match[1].toLowerCase();
  const candidates = chat.members
    .filter((mb) => mb.id !== state.me.id &&
      (mb.displayName.toLowerCase().includes(q) || mb.username.toLowerCase().includes(q)))
    .slice(0, 6);
  if (!candidates.length) { box.classList.add('hidden'); return; }
  box.innerHTML = '';
  for (const mb of candidates) {
    const av = el('span', { class: 'avatar sm' });
    avatarBg(av, mb.avatarUrl, mb.displayName);
    box.append(el('div', { class: 'mention-opt', onclick: () => pickMention(mb, match[1].length) },
      av, el('span', {}, mb.displayName), el('span', { class: 'mention-user' }, '@' + mb.username)));
  }
  box.classList.remove('hidden');
}

function pickMention(mb, tokenLen) {
  const input = $('#message-input');
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos - tokenLen - 1); // drop "@token"
  const after = input.value.slice(pos);
  const insert = `@${mb.displayName} `;
  input.value = before + insert + after;
  const np = (before + insert).length;
  input.focus();
  input.setSelectionRange(np, np);
  state.composerMentions.set(mb.displayName, mb.id);
  $('#mention-suggest').classList.add('hidden');
}

// Collect mention userIds whose @name still appears in the text.
function collectMentions(text) {
  const out = [];
  for (const [name, uid] of state.composerMentions) {
    if (text.includes('@' + name)) out.push(uid);
  }
  return out;
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
    _localMediaUrl: payload._localMediaUrl || null,
    replyTo: payload.replyTo || null,
    mentions: payload.mentions || [],
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
async function deliver(payload) {
  if (!socketIsConnected()) {
    if (state.socket && typeof state.socket.connect === 'function') {
      try { state.socket.connect(); } catch { /* Socket.IO will retry on its own too. */ }
    }
    const reachable = await hasInternetConnection({ timeoutMs: 2500 });
    if (reachable) {
      updateNetIndicator();
      return;
    }
    if (state.mesh && state.mesh.enabled) meshDeliver(payload);
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
  haptic('light');
  payload.clientId = newClientId();
  addToOutbox(payload);
  const opt = optimisticMessage(payload);
  if (plainText != null) opt._plain = plainText;
  addMessage(opt);
  deliver(payload);
}

let _sendGuard = false;

async function sendTextMessageFromComposer(isFromEnter = false) {
  const input = $('#message-input');
  if (!input) return false;

  const body = input.value.trim();
  if (!body || !state.activeChatId) {
    requestAnimationFrame(() => input.focus());
    return false;
  }

  // Envio direto e robusto (sem blur/timeout, que travavam em vários celulares).
  // A guarda evita duplicidade quando touch/pointer/click chegam juntos.
  if (_sendGuard) return false;
  _sendGuard = true;

  try {
    if (localStorage.getItem('speedvox_panic_active') === '1') {
      const msg = {
        id: `local-fake-${Date.now()}`,
        chatId: state.activeChatId,
        senderId: state.me.id,
        type: 'text',
        body,
        createdAt: Date.now(),
        pending: false
      };
      const list = state.messages.get(state.activeChatId) || [];
      list.push(msg);
      state.messages.set(state.activeChatId, list);
      const chat = state.chats.get(state.activeChatId);
      if (chat) chat.lastMessage = msg;
      input.value = '';
      input.style.height = 'auto';
      renderMessages(true);
      renderChatList();

      setTimeout(() => {
        let replyText = 'Beleza!';
        if (state.activeChatId === 'mock-1') replyText = 'Deus te abençoe, filho!';
        else if (state.activeChatId === 'mock-2') replyText = 'Tá bom amor. Bjs!';
        else if (state.activeChatId === 'mock-3') replyText = 'Entendido, obrigado pelo aviso.';
        const replyMsg = {
          id: `local-fake-${Date.now()}`,
          chatId: state.activeChatId,
          senderId: 'other',
          type: 'text',
          body: replyText,
          createdAt: Date.now(),
          pending: false
        };
        list.push(replyMsg);
        if (chat) chat.lastMessage = replyMsg;
        renderMessages(true);
        renderChatList();
      }, 1500 + Math.random() * 1500);
      return true;
    }

    // Editing an existing message takes priority over sending a new one.
    if (state.editing) {
      input.value = '';
      input.style.height = 'auto';
      await applyEdit(body);
      return true;
    }

    const chat = state.chats.get(state.activeChatId);
    const payload = { chatId: state.activeChatId, body, type: 'text' };
    if (state.ghostModeActive) payload.ghostTtl = 15;
    if (state.replyTo) payload.replyTo = state.replyTo.id;

    // Group @mentions.
    if (chat && chat.type === 'group') {
      const mentions = collectMentions(body);
      if (mentions.length) payload.mentions = mentions;
    }
    state.composerMentions.clear();
    $('#mention-suggest').classList.add('hidden');

    // Encrypt end-to-end for direct chats (shared with scheduled sends).
    const enc = await encryptOutgoing(chat, body);
    payload.body = enc.body;
    if (enc.encrypted) payload.encrypted = true;
    const plainText = enc.plainText;

    queueAndSend(payload, plainText);
    input.value = '';
    input.style.height = 'auto';
    hideComposerPreview();
    clearReply();
    
    // Re-focus so mobile keyboard stays up for rapid follow-up messages.
    requestAnimationFrame(() => input.focus());
    if (state.socket && state.socket.connected) {
      state.socket.emit('typing', { chatId: state.activeChatId, isTyping: false });
    }
    return true;
  } catch (err) {
    console.error('sendTextMessageFromComposer', err);
    toast(err && err.crypto ? err.message : 'Falha ao enviar mensagem. Tente novamente.');
    requestAnimationFrame(() => input.focus());
    return false;
  } finally {
    setTimeout(() => { _sendGuard = false; }, 250);
  }
}

// Encrypt an outgoing body for a chat. Prefers the forward-secret Double
// Ratchet, falls back to the static key, else plaintext. Returns the body to
// send plus whether it's encrypted and the plaintext (for the local echo).
async function encryptOutgoing(chat, body) {
  // GRUPO: cifra com a minha sender key (E2EE de grupo). Best-effort — se algo
  // falhar, envia em claro para o grupo não quebrar (v1). Fail-closed vem depois.
  if (chat && chat.type === 'group') {
    try {
      const env = await groupEncryptFor(chat, body);
      if (env) return { body: env, encrypted: true, plainText: body };
    } catch (err) { console.warn('E2EE de grupo falhou; enviando em claro', err); }
    return { body, encrypted: false, plainText: undefined };
  }
  if (!chat || chat.type !== 'direct') {
    return { body, encrypted: false, plainText: undefined };
  }

  const hadPeerKey = Boolean(chat.otherUser && chat.otherUser.publicKey);

  try {
    const ratEnv = await ratchetEncryptFor(chat, body);
    if (ratEnv) return { body: ratEnv, encrypted: true, plainText: body };
  } catch (err) {
    console.warn('Double Ratchet encrypt failed; resetting this chat session', err);
    await resetChatCryptoSession(chat);
  }

  try {
    const key = await ensureChatKey(chat);
    if (key) return { body: JSON.stringify(await e2ee.encrypt(key, body)), encrypted: true, plainText: body };
  } catch (err) {
    console.warn('Static E2EE encrypt failed; refreshing peer key', err);
    await resetChatCryptoSession(chat);
  }

  const peerHasKey = Boolean(chat.otherUser && chat.otherUser.publicKey);
  if (hadPeerKey || peerHasKey) {
    try {
      await resetChatCryptoSession(chat);
      const recoveredKey = await ensureChatKey(chat);
      if (recoveredKey) {
        return { body: JSON.stringify(await e2ee.encrypt(recoveredKey, body)), encrypted: true, plainText: body };
      }
    } catch (err) {
      console.warn('E2EE recovery failed', err);
    }
    const error = new Error('Erro de segurança: não foi possível criptografar a mensagem. A sessão foi renegociada; tente enviar novamente.');
    error.crypto = true;
    throw error;
  }

  return { body, encrypted: false, plainText: undefined };
}

// Schedule the currently typed message for a future time (Telegram-style).
async function scheduleCurrentMessage() {
  const input = $('#message-input');
  const body = input.value.trim();
  if (!body || !state.activeChatId) return toast('Escreva a mensagem primeiro');
  const when = el('input', { type: 'datetime-local' });
  // Default suggestion: 1 hour from now (local time).
  const d = new Date(Date.now() + 3600 * 1000 - new Date().getTimezoneOffset() * 60000);
  when.value = d.toISOString().slice(0, 16);
  const confirm = el('button', { class: 'btn-primary', onclick: async () => {
    const ts = new Date(when.value).getTime();
    if (!ts || ts < Date.now() + 5000) return toast('Escolha um horário no futuro');
    const chat = state.chats.get(state.activeChatId);
    let enc;
    try {
      enc = await encryptOutgoing(chat, body);
    } catch (err) {
      return toast(err && err.crypto ? err.message : 'Falha ao preparar mensagem');
    }
    const payload = { chatId: state.activeChatId, type: 'text', body: enc.body, sendAt: ts };
    if (enc.encrypted) payload.encrypted = true;
    state.socket.emit('message:send', payload, (res) => {
      if (res && res.error) toast(res.error);
      else toast('Mensagem agendada para ' + new Date(ts).toLocaleString('pt-BR'));
    });
    input.value = ''; input.style.height = 'auto';
    backdrop.remove();
  } }, 'Agendar');
  const bodyEl = el('div', { class: 'modal-body' },
    el('div', { class: 'field-label' }, 'Enviar em'), when,
    el('p', { class: 'auth-hint', style: 'margin-top:6px' }, 'A mensagem fica guardada e é enviada automaticamente no horário escolhido.'),
    el('div', { style: 'margin-top:14px' }, confirm));
  const backdrop = modalShell('Agendar mensagem', bodyEl);
}

// Display pending scheduled messages for the active chat in a modal.
async function showScheduledMessagesModal() {
  if (!state.activeChatId) return;
  const listEl = el('div', { style: 'max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px;' });

  const refreshList = async () => {
    listEl.innerHTML = '';
    try {
      const res = await fetch(apiUrl(`/api/chats/${state.activeChatId}/messages/scheduled`));
      const data = await res.json();
      const messages = data.messages || [];

      if (!messages.length) {
        listEl.append(el('p', { style: 'color: var(--text-2); text-align: center; margin: 20px 0;' }, 'Nenhuma mensagem agendada neste chat.'));
        return;
      }

      for (const m of messages) {
        if (m.encrypted && m._plain == null) {
          await decryptInto(m);
        }

        const text = m.deleted ? '(Apagada)' : (m._decryptFailed ? '🔒 Não decifrado' : (m._plain || m.body));
        const item = el('div', { style: 'background: var(--panel-3); padding: 12px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid var(--border);' });
        const left = el('div', { style: 'flex: 1; min-width: 0;' });
        left.append(el('div', { style: 'word-break: break-word; color: var(--text-1); font-size: 14px;' }, text));
        left.append(el('div', { style: 'font-size: 11px; color: var(--text-2); margin-top: 6px; display: flex; align-items: center; gap: 4px;' }, '⏰ ' + new Date(m.sendAt).toLocaleString('pt-BR')));

        const delBtn = el('button', {
          style: 'background: none; border: none; font-size: 18px; cursor: pointer; color: #ff5252; padding: 6px; display: flex; align-items: center; justify-content: center; transition: transform 0.2s;',
          title: 'Cancelar agendamento',
          onclick: () => {
            if (confirm('Cancelar e apagar esta mensagem agendada?')) {
              state.socket.emit('message:delete', { messageId: m.id });
              setTimeout(refreshList, 400); // refresh list
            }
          }
        }, '🗑️');

        item.append(left, delBtn);
        listEl.append(item);
      }
    } catch (err) {
      listEl.append(el('p', { style: 'color: #ff5252; text-align: center;' }, 'Erro ao carregar mensagens agendadas.'));
    }
  };

  await refreshList();

  const bodyEl = el('div', { class: 'modal-body' },
    listEl,
    el('div', { style: 'margin-top: 18px; display: flex; justify-content: flex-end;' },
      el('button', { class: 'btn-primary', onclick: () => backdrop.remove() }, 'Fechar'))
  );

  const backdrop = modalShell('Mensagens Agendadas', bodyEl);
}

// Create a poll (Telegram-style) in the active chat.
function pollComposeModal() {
  if (!state.activeChatId) return;
  const question = el('input', { type: 'text', placeholder: 'Pergunta' });
  const optWrap = el('div', {});
  const opts = [];
  function addOpt(val = '') {
    if (opts.length >= 10) return;
    const inp = el('input', { type: 'text', placeholder: `Opção ${opts.length + 1}` });
    inp.value = val;
    opts.push(inp);
    optWrap.append(inp);
  }
  addOpt(); addOpt();
  const addBtn = el('button', { class: 'btn-primary', style: 'background:var(--panel-3);margin-bottom:12px',
    onclick: () => addOpt() }, '＋ Adicionar opção');
  const multi = el('input', { type: 'checkbox' });
  const multiRow = el('label', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:12px' },
    multi, el('span', {}, 'Permitir múltiplas escolhas'));
  const create = el('button', { class: 'btn-primary', onclick: () => {
    const q = question.value.trim();
    const options = opts.map((o) => o.value.trim()).filter(Boolean);
    if (!q) return toast('Escreva a pergunta');
    if (options.length < 2) return toast('Informe ao menos 2 opções');
    state.socket.emit('message:send', {
      chatId: state.activeChatId, type: 'poll',
      body: JSON.stringify({ question: q, options, multi: multi.checked }),
    }, (res) => { if (res && res.error) toast(res.error); });
    backdrop.remove();
  } }, 'Criar enquete');
  const bodyEl = el('div', { class: 'modal-body' },
    el('div', { class: 'field-label' }, 'Pergunta'), question,
    el('div', { class: 'field-label' }, 'Opções'), optWrap, addBtn, multiRow, create);
  const backdrop = modalShell('Nova enquete', bodyEl);
  setTimeout(() => question.focus(), 50);
}

// Render a poll bubble with live results; tapping an option votes.
// ---------------------------------------------- anexos: cartões (novos tipos)
// Corpo dos cartões (location/contact/event/pix) — JSON, cifrado como texto em
// chats E2EE. Lê do _plain (decifrado) ou do body (em claro).
function cardData(m) {
  const raw = m.encrypted ? m._plain : m.body;
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Envia um cartão: monta o JSON, cifra igual a texto e envia pelo fluxo normal.
async function sendCard(type, data) {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return toast('Abra uma conversa primeiro');
  const enc = await encryptOutgoing(chat, JSON.stringify(data));
  const payload = { chatId: chat.id, type, body: enc.body };
  if (enc.encrypted) payload.encrypted = true;
  queueAndSend(payload, enc.plainText);
}

function cardShell(iconName, title, ...children) {
  return el('div', { class: 'attach-card' },
    el('div', { class: 'attach-card-head' }, icon(iconName, { size: 18 }), el('span', {}, title)),
    ...children);
}

// ---- Localização ----
function sendLocationMessage() {
  if (!navigator.geolocation) return toast('Localização indisponível neste aparelho');
  toast('Obtendo localização…');
  navigator.geolocation.getCurrentPosition(
    (pos) => sendCard('location', { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) }),
    () => toast('Não foi possível obter a localização (permissão negada?)'),
    { enableHighAccuracy: true, timeout: 12000 });
}
function locationNode(m) {
  const d = cardData(m);
  if (!d) return el('div', { class: 'attach-card' }, m.encrypted ? '🔒 Decifrando…' : '📍 Localização');
  const maps = `https://www.google.com/maps?q=${d.lat},${d.lng}`;
  return cardShell('map-pin', 'Localização',
    el('div', { class: 'attach-card-sub' }, `${d.lat}, ${d.lng}`),
    el('a', { class: 'attach-card-btn', href: maps, target: '_blank', rel: 'noopener' }, 'Ver no mapa'));
}

// ---- Contato ----
function shareContactModal() {
  const directs = [...state.chats.values()].filter((c) => c.type === 'direct' && c.otherUser);
  const list = el('div', {});
  if (!directs.length) list.append(el('p', { class: 'auth-hint' }, 'Você ainda não tem contatos para compartilhar.'));
  for (const c of directs) {
    const u = c.otherUser;
    const av = el('span', { class: 'avatar sm' }); avatarBg(av, u.avatarUrl, u.displayName);
    list.append(el('div', { class: 'user-result', onclick: () => {
      backdrop.remove();
      sendCard('contact', { name: u.displayName, username: u.username || '', userId: u.id });
    } }, av, el('div', { class: 'user-result-body' },
      el('div', { class: 'user-result-name' }, u.displayName),
      el('div', { class: 'user-result-sub' }, '@' + (u.username || '')))));
  }
  const backdrop = modalShell('Compartilhar contato', el('div', { class: 'modal-body' }, list));
}
function contactCardNode(m) {
  const d = cardData(m);
  if (!d) return el('div', { class: 'attach-card' }, m.encrypted ? '🔒 Decifrando…' : '👤 Contato');
  const av = el('span', { class: 'avatar sm' }); avatarBg(av, null, d.name);
  const open = d.userId ? el('button', { class: 'attach-card-btn', onclick: () => openChatWithUser(d.userId) }, 'Conversar') : '';
  return el('div', { class: 'attach-card' },
    el('div', { class: 'attach-card-head' }, icon('user', { size: 18 }), el('span', {}, 'Contato')),
    el('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:6px' }, av,
      el('div', {}, el('div', { style: 'font-weight:600' }, d.name),
        d.username ? el('div', { class: 'attach-card-sub' }, '@' + d.username) : '')),
    open);
}
async function openChatWithUser(userId) {
  try { const { chat } = await api.openDirect(userId); if (chat) { state.chats.set(chat.id, chat); renderChatList(); openChat(chat.id); } }
  catch { toast('Não foi possível abrir a conversa'); }
}

// ---- Evento ----
function eventComposeModal() {
  const title = el('input', { type: 'text', placeholder: 'Título do evento' });
  const when = el('input', { type: 'datetime-local' });
  const place = el('input', { type: 'text', placeholder: 'Local (opcional)' });
  const send = el('button', { class: 'btn-primary', onclick: () => {
    if (!title.value.trim()) return toast('Dê um título ao evento');
    const ts = when.value ? new Date(when.value).getTime() : 0;
    if (!ts) return toast('Escolha data e hora');
    backdrop.remove();
    sendCard('event', { title: title.value.trim(), at: ts, place: place.value.trim() });
  } }, 'Enviar evento');
  const backdrop = modalShell('Novo evento', el('div', { class: 'modal-body' },
    el('div', { class: 'field-label' }, 'Título'), title,
    el('div', { class: 'field-label', style: 'margin-top:10px' }, 'Quando'), when,
    el('div', { class: 'field-label', style: 'margin-top:10px' }, 'Local'), place,
    el('div', { style: 'margin-top:14px' }, send)));
}
function eventNode(m) {
  const d = cardData(m);
  if (!d) return el('div', { class: 'attach-card' }, m.encrypted ? '🔒 Decifrando…' : '📅 Evento');
  const dt = d.at ? new Date(d.at) : null;
  const dstr = dt ? dt.toLocaleString('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const gcal = dt ? `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(d.title)}&dates=${gcalDate(dt)}/${gcalDate(new Date(d.at + 3600000))}${d.place ? '&location=' + encodeURIComponent(d.place) : ''}` : '';
  return cardShell('calendar', 'Evento',
    el('div', { style: 'font-weight:600;margin-top:4px' }, d.title),
    dstr ? el('div', { class: 'attach-card-sub' }, '🗓️ ' + dstr) : '',
    d.place ? el('div', { class: 'attach-card-sub' }, '📍 ' + d.place) : '',
    gcal ? el('a', { class: 'attach-card-btn', href: gcal, target: '_blank', rel: 'noopener' }, 'Adicionar à agenda') : '');
}
function gcalDate(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

// ---- Pix ----
function pixComposeModal() {
  const key = el('input', { type: 'text', placeholder: 'Chave Pix (CPF, e-mail, telefone, aleatória)' });
  const name = el('input', { type: 'text', placeholder: 'Nome do recebedor (opcional)', value: state.me ? state.me.displayName : '' });
  const amount = el('input', { type: 'number', placeholder: 'Valor R$ (opcional)', step: '0.01', min: '0' });
  const send = el('button', { class: 'btn-primary', onclick: () => {
    if (!key.value.trim()) return toast('Informe a chave Pix');
    backdrop.remove();
    sendCard('pix', { key: key.value.trim(), name: name.value.trim(), amount: amount.value ? Number(amount.value) : null });
  } }, 'Enviar Pix');
  const backdrop = modalShell('Enviar Pix', el('div', { class: 'modal-body' },
    el('div', { class: 'field-label' }, 'Chave Pix'), key,
    el('div', { class: 'field-label', style: 'margin-top:10px' }, 'Recebedor'), name,
    el('div', { class: 'field-label', style: 'margin-top:10px' }, 'Valor'), amount,
    el('div', { style: 'margin-top:14px' }, send)));
}
function pixNode(m) {
  const d = cardData(m);
  if (!d) return el('div', { class: 'attach-card' }, m.encrypted ? '🔒 Decifrando…' : '💠 Pix');
  const val = (d.amount != null) ? ('R$ ' + Number(d.amount).toFixed(2).replace('.', ',')) : '';
  const copy = el('button', { class: 'attach-card-btn', onclick: async () => {
    try { await navigator.clipboard.writeText(d.key); toast('Chave Pix copiada'); } catch { toast('Copie a chave manualmente'); }
  } }, 'Copiar chave Pix');
  return cardShell('key', 'Pix' + (val ? ' · ' + val : ''),
    d.name ? el('div', { style: 'font-weight:600;margin-top:4px' }, d.name) : '',
    el('div', { class: 'attach-card-sub', style: 'word-break:break-all' }, d.key),
    copy);
}

function pollNode(m) {
  const poll = m.poll;
  const total = poll.votes.length;
  const myVotes = new Set(poll.votes.filter((v) => v.userId === state.me.id).map((v) => v.option));
  const wrap = el('div', { class: 'poll' });
  wrap.append(el('div', { class: 'poll-q' }, poll.question));
  poll.options.forEach((opt, i) => {
    const count = poll.votes.filter((v) => v.option === i).length;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const row = el('div', { class: 'poll-opt' + (myVotes.has(i) ? ' voted' : '') },
      el('div', { class: 'poll-fill', style: `width:${pct}%` }),
      el('div', { class: 'poll-opt-label' }, (myVotes.has(i) ? '✓ ' : '') + opt),
      el('div', { class: 'poll-opt-count' }, String(count)));
    row.onclick = () => { if (state.socket) state.socket.emit('poll:vote', { messageId: m.id, option: i }); };
    wrap.append(row);
  });
  wrap.append(el('div', { class: 'poll-total' },
    (total === 0 ? 'Sem votos ainda' : `${total} voto(s)`) + (poll.multi ? ' · múltipla escolha' : '')));
  return wrap;
}

// Read a File/Blob as base64 (without the "data:...;base64," prefix).
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(new Error('Falha ao ler o arquivo'));
    r.readAsDataURL(file);
  });
}

// Deliver a media item. When online, upload to the server (full size, any file).
// When offline but the mesh is up, send it chunked over the mesh so voice notes
// and photos still reach nearby people in a blackout — no internet, no towers.
// Tipo da mensagem a partir do mime (foto, vídeo, áudio ou arquivo genérico).
function mediaTypeFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  // Some containers are misidentified by browsers; extend by extension too.
  const ext = m.split('/')[1] || '';
  if (['mp3','aac','flac','wav','ogg','opus','m4a','wma','aiff','ape','alac','amr','ra'].includes(ext)) return 'audio';
  if (['mp4','mkv','avi','mov','webm','wmv','flv','m4v','ts'].includes(ext)) return 'video';
  return 'file';
}

// ── File-type icon map ────────────────────────────────────────────────────────
const FILE_ICONS = {
  pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗',
  ppt: '📙', pptx: '📙', txt: '📄', md: '📄', csv: '📊',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
  mp3: '🎵', flac: '🎵', wav: '🎵', aac: '🎵', ogg: '🎵',
  opus: '🎵', m4a: '🎵', wma: '🎵', aiff: '🎵', amr: '🎵',
  mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬',
};
function fileIcon(name, mime) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return FILE_ICONS[ext] || (String(mime || '').startsWith('image/') ? '🖼️' : '📎');
}

function detectMediaType(file, mime, forcedType) {
  if (forcedType) return forcedType;
  const byMime = mediaTypeFor(mime || file?.type || '');
  if (byMime !== 'file') return byMime;
  const ext = (file?.name || '').split('.').pop().toLowerCase();
  return ext ? mediaTypeFor(`/${ext}`) : 'file';
}

function mediaKindLabel(type, file) {
  const finalType = detectMediaType(file, file?.type, type);
  if (finalType === 'audio') return 'Áudio';
  if (finalType === 'video') return 'Vídeo';
  if (finalType === 'image') return 'Imagem';
  return 'Arquivo';
}

function isUploadValidationError(err) {
  return [400, 413, 415].includes(Number(err && err.status));
}

function isNetworkUploadError(err) {
  if (!err) return false;
  if (err.network || err.name === 'AbortError') return true;
  if (err.status) return false;
  return /network|rede|failed to fetch|load failed|internet|offline|conex/i.test(String(err.message || ''));
}

function uploadErrorMessage(err, type, file) {
  const status = Number(err && err.status);
  const kind = mediaKindLabel(type, file);
  if (status === 413) return `${kind} muito pesado`;
  if (status === 415) return 'Formato não aceito';
  if (status === 400) return 'Arquivo inválido';
  if (status === 401 || status === 403) return 'Sessão expirada. Entre novamente.';
  if (status === 429) return 'Muitas tentativas. Tente novamente em instantes.';
  if (status >= 500) return 'Erro no servidor. Tente novamente.';
  if (isNetworkUploadError(err)) return 'Sem conexão';
  return (err && err.message) || 'Falha no upload';
}

async function queueUploadedMedia(up, file, type, mediaName, enc) {
  const finalType = detectMediaType(file, enc ? enc.mime : up.mime, type);
  const payload = {
    chatId: state.activeChatId,
    type: finalType,
    mediaUrl: up.url,
    mediaName: mediaName || up.name || file.name,
    // Guarda o mime ORIGINAL (o upload cifrado é octet-stream) para o blob
    // decifrado renderizar certo.
    mediaMime: enc ? enc.mime : (up.mime || file.type || 'application/octet-stream'),
    replyTo: state.replyTo ? state.replyTo.id : undefined,
    ghostTtl: state.ghostModeActive ? 15 : undefined,
  };

  if (enc) {
    const chat = state.chats.get(state.activeChatId);
    const envelope = JSON.stringify({ v: 1, mk: enc.mk, iv: enc.iv, name: enc.name, mime: enc.mime, caption: '' });
    let out;
    try { out = await encryptOutgoing(chat, envelope); }
    catch { toast('Falha ao cifrar a mídia; tente novamente.'); return; }
    if (!out || !out.encrypted) { toast('Falha ao cifrar a mídia; tente novamente.'); return; }
    payload.body = out.body;
    payload.encrypted = true;
    // Eco local do remetente: mostra o arquivo original (ele já o tem).
    payload._localMediaUrl = URL.createObjectURL(file);
    queueAndSend(payload, ''); // _plain='' evita tentar decifrar o próprio envio
    return;
  }

  queueAndSend(payload);
}

async function sendMediaViaMesh({ file, type, mediaName }) {
  if (!(state.mesh && state.mesh.enabled)) {
    toast('Sem conexão. Envio offline disponível pela Rede Mesh.');
    return false;
  }
  const b64 = await fileToBase64(file);
  if (b64.length > 700000) {
    toast('Mídia grande demais para a Rede Mesh. Tente um áudio curto ou foto menor.');
    return false;
  }
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return false;
  const mime = file.type || 'application/octet-stream';
  const finalType = detectMediaType(file, mime, type);
  // Show it locally right away with a data: URL.
  const msg = optimisticMessage({
    clientId: newClientId(), chatId: chat.id, type: finalType,
    mediaUrl: `data:${mime};base64,${b64}`, mediaName: mediaName || file.name, mediaMime: mime,
  });
  msg.pending = false;
  addMessage(msg);
  const meta = { chatId: chat.id, type: finalType, mime, name: mediaName || file.name, b64 };
  if (chat.type === 'direct' && chat.otherUser) {
    state.mesh.sendMedia(chat.otherUser.id, meta);
  } else if (chat.type === 'group' && Array.isArray(chat.members)) {
    for (const m of chat.members) if (m.id !== state.me.id) state.mesh.sendMedia(m.id, meta);
  }
  toast('Enviando pela Rede Mesh…');
  return true;
}

async function deliverMedia({ file, type, mediaName, onProgress } = {}) {
  if (!state.activeChatId) return false;

  const chat = state.chats.get(state.activeChatId);
  // Arquivos grandes (>20 MB) vão em PEDAÇOS — furam o limite ~100 MB do
  // Cloudflare e o nginx só precisa aceitar o tamanho do pedaço.
  const isLarge = file.size > 20 * 1024 * 1024;

  // E2EE de mídia (Lote 2): só p/ arquivos pequenos em chat direto — cifrar 1 GB
  // de uma vez estouraria a memória do WebView. Mídia grande vai em pedaços SEM
  // E2EE por ora (cifra em streaming fica pra depois).
  let enc = null;
  let uploadFile = file;
  try {
    if (!isLarge && state.e2eeReady && chat && chat.type === 'direct' && chat.otherUser) {
      const key = await ensureChatKey(chat);
      if (key) {
        const r = await encryptFileBytes(file);
        enc = { mk: r.mk, iv: r.iv, name: mediaName || file.name, mime: file.type || 'application/octet-stream' };
        uploadFile = r.encFile;
      }
    }
  } catch { enc = null; uploadFile = file; }

  let uploadErr = null;
  try {
    const up = isLarge
      ? await api.uploadChunked(file, onProgress)
      : (onProgress ? await api.uploadWithProgress(uploadFile, onProgress) : await api.upload(uploadFile));
    setServerReachable(true);
    await queueUploadedMedia(up, file, type, mediaName, enc);
    updateNetIndicator();
    return true;
  } catch (err) {
    uploadErr = err;
    if (isUploadValidationError(err) || (err && err.status)) {
      toast(uploadErrorMessage(err, type, file));
      return false;
    }
    if (!isNetworkUploadError(err)) {
      toast(uploadErrorMessage(err, type, file));
      return false;
    }
  }

  const reachable = await hasInternetConnection({ force: true, timeoutMs: 2500 });
  if (reachable) {
    toast('Falha no upload. Tente novamente.');
    return false;
  }
  if (uploadErr) setServerReachable(false);
  return sendMediaViaMesh({ file, type, mediaName });
}

// ── Single-file send (legacy voice-recording path) ───────────────────────────
async function sendFile(file) {
  if (!file || !state.activeChatId) return;
  try {
    const ok = await deliverMedia({ file });
    if (ok) clearReply();
  } catch (err) { toast('Falha no envio: ' + uploadErrorMessage(err, undefined, file)); }
}

// ── Multi-file send — up to 500 files, with per-batch progress toast ──────────
async function sendFiles(fileList) {
  if (!fileList || fileList.length === 0 || !state.activeChatId) return;
  const files = Array.from(fileList);

  // Validate total count.
  if (files.length > 500) return toast('Máximo de 500 arquivos por vez');

  // Warn about large files (>1 GB each).
  const tooBig = files.filter(f => f.size > 1073741824);
  if (tooBig.length) return toast(`${tooBig.length} arquivo(s) excedem 1 GB e foram ignorados`);

  // Show a progress toast that we'll update.
  const tEl = el('div', { class: 'toast upload-progress-toast' });
  const bar = el('div', { class: 'upload-progress-bar' });
  const label = el('span', {}, `Enviando 0/${files.length}…`);
  tEl.append(label, bar);
  document.body.append(tEl);
  requestAnimationFrame(() => tEl.classList.add('show'));

  let sent = 0;

  for (const file of files) {
    try {
      const ok = await deliverMedia({ file, onProgress: (pct) => {
        bar.style.width = `${pct}%`;
      } });
      if (ok) {
        sent++;
        label.textContent = `Enviando ${sent}/${files.length}…`;
        bar.style.width = `${Math.round((sent / files.length) * 100)}%`;
      }
    } catch (err) {
      toast(`Falha: ${file.name} — ${uploadErrorMessage(err, undefined, file)}`);
    }
  }

  // Dismiss progress toast.
  tEl.classList.remove('show');
  setTimeout(() => tEl.remove(), 400);
  if (sent) {
    toast(`✅ ${sent} arquivo(s) enviado(s)`);
    clearReply();
  }
}

// ------------------------------------------------------------------ composer
let typingTimer = null;
let composerPreviewTimer = null;
let composerPreviewUrl = null;

function showComposerPreview(d, url) {
  const wrap = $('#composer-link-preview');
  if (!wrap || !d || (!d.title && !d.image)) { hideComposerPreview(); return; }
  composerPreviewUrl = url;
  const img = $('#composer-preview-img');
  if (d.image) { img.src = d.image; img.style.display = 'block'; }
  else img.style.display = 'none';
  $('#composer-preview-site').textContent = d.site || '';
  $('#composer-preview-title').textContent = d.title || '';
  $('#composer-preview-desc').textContent = d.description || '';
  wrap.style.display = 'flex';
}

function hideComposerPreview() {
  const wrap = $('#composer-link-preview');
  if (wrap) wrap.style.display = 'none';
  composerPreviewUrl = null;
}

function setupComposer() {
  const composer = $('#composer');
  const input = $('#message-input');
  $('#composer-preview-close').onclick = () => {
    hideComposerPreview();
    composerPreviewTimer = null;
  };

  let lastSendRequestAt = 0;
  function requestComposerSend(event, isFromEnter = false) {
    if (event) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    }
    const nowTs = Date.now();
    if (nowTs - lastSendRequestAt < 220) return;
    lastSendRequestAt = nowTs;
    sendTextMessageFromComposer(isFromEnter);
  }

  function resizeComposerInput() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  const isLineBreakInput = (event) =>
    event && (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph');

  let isComposing = false;
  let allowNextLineBreak = false;
  let allowedLineBreakInserted = false;

  input.addEventListener('input', (event) => {
    if (isLineBreakInput(event) && !allowedLineBreakInserted && !isComposing) {
      input.value = input.value.replace(/\n+$/g, '');
      resizeComposerInput();
      requestComposerSend(null, true);
      return;
    }
    if (allowedLineBreakInserted) allowedLineBreakInserted = false;
    resizeComposerInput();
    updateMentionSuggest();
    if (!state.activeChatId) return;
    state.socket.emit('typing', { chatId: state.activeChatId, isTyping: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(
      () => state.socket.emit('typing', { chatId: state.activeChatId, isTyping: false }), 1800);
    // Live link preview debounce (600ms)
    clearTimeout(composerPreviewTimer);
    composerPreviewTimer = setTimeout(async () => {
      const url = firstUrl(input.value);
      if (!url || url === composerPreviewUrl) return;
      try {
        const d = await api.linkPreview(url);
        if (d && (d.title || d.image)) showComposerPreview(d, url);
      } catch { /* ignore */ }
    }, 600);
  });
  input.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  input.addEventListener('compositionend', () => {
    isComposing = false;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) {
      if (isComposing || e.isComposing) return;
      if (e.shiftKey) {
        allowNextLineBreak = true;
        setTimeout(() => { allowNextLineBreak = false; }, 120);
        return;
      }
      requestComposerSend(e, true);
    }
  });
  // Alguns teclados Android (Gboard com a tecla "Enviar") NÃO geram keydown
  // Enter — disparam "insertLineBreak" ou "insertParagraph". Tratamos também.
  input.addEventListener('beforeinput', (e) => {
    if (isLineBreakInput(e)) {
      if (allowNextLineBreak) {
        allowNextLineBreak = false;
        allowedLineBreakInserted = true;
        return;
      }
      if (!isComposing && !e.isComposing) requestComposerSend(e, true);
    }
  });
  const sendBtn = $('#send-btn');
  composer.addEventListener('submit', (e) => requestComposerSend(e, false));
  // Redundância deliberada para PWA/WebView: alguns aparelhos entregam pointer
  // sem click, outros click sem pointer. A guarda acima impede envio duplo.
  sendBtn.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    requestComposerSend(e, false);
  });
  sendBtn.addEventListener('touchend', (e) => requestComposerSend(e, false), { passive: false });
  sendBtn.addEventListener('click', (e) => {
    requestComposerSend(e, false);
  });
  $('#reply-cancel').onclick = () => {
    if (state.editing) { $('#message-input').value = ''; $('#message-input').style.height = 'auto'; }
    clearReply();
  };
  $('#emoji-btn').onclick = (e) => openEmojiPopup(e.currentTarget, EMOJI_SET, (emoji) => {
    const input = $('#message-input');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.focus();
    const pos = start + emoji.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input'));
  });
  $('#attach-btn').onclick = (e) => {
    document.querySelector('.popup-menu')?.remove();
    const menu = el('div', { class: 'popup-menu' });
    const item = (iconName, label, fn) => el('div', { class: 'popup-item', onclick: (ev) => {
      ev.stopPropagation(); menu.remove(); fn();
    } }, icon(iconName, { size: 18 }), el('span', {}, label));
    menu.append(item('paperclip', 'Foto ou arquivo', () => $('#file-input').click()));
    menu.append(item('map-pin', 'Localização', () => sendLocationMessage()));
    menu.append(item('user', 'Contato', () => shareContactModal()));
    menu.append(item('calendar', 'Evento', () => eventComposeModal()));
    menu.append(item('key', 'Pix', () => pixComposeModal()));
    menu.append(item('chart', 'Enquete', () => pollComposeModal()));
    menu.append(item('clock', 'Agendar mensagem', () => scheduleCurrentMessage()));
    menu.append(item('calendar', 'Mensagens agendadas', () => showScheduledMessagesModal()));

    const ghostLabel = state.ghostModeActive ? 'Desativar Modo Fantasma' : 'Ativar Modo Fantasma';
    menu.append(item('ghost', ghostLabel, () => {
      state.ghostModeActive = !state.ghostModeActive;
      updateComposerPlaceholder();
      toast(state.ghostModeActive ? '👻 Modo Fantasma Ativado! (mensagem some em 15s após visualizada)' : '👻 Modo Fantasma Desativado');
    }));

    document.body.append(menu);
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, window.innerWidth - 200)}px`;
    menu.style.top = `${r.top - menu.offsetHeight - 6}px`;
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
  };

  $('#file-input').onchange = (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (files.length === 1) sendFile(files[0]); // keep single-file fast path
    else sendFiles(files);
    e.target.value = '';
  };
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
  $('#tasks-btn').onclick = showTasksModal;
  $('#mic-btn').onclick = toggleVoiceRecording;
  $('#unblock-btn').onclick = async () => {
    const chat = state.chats.get(state.activeChatId);
    if (!chat || !chat.otherUser) return;
    await api.unblockUser(chat.otherUser.id);
    const { chat: updated } = await api.getChat(chat.id);
    state.chats.set(updated.id, updated);
    updateComposerState(updated);
    toast('Contato desbloqueado');
  };
}

function updateComposerPlaceholder() {
  const input = $('#message-input');
  if (!input) return;
  if (state.ghostModeActive) {
    input.placeholder = '👻 Mensagem Fantasma (some em 15s)...';
    input.style.border = '1px dashed var(--accent)';
    input.style.boxShadow = '0 0 8px rgba(138, 43, 226, 0.4)';
  } else {
    input.placeholder = 'Mensagem';
    input.style.border = '';
    input.style.boxShadow = '';
  }
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch {
    toast('Não foi possível acessar o microfone');
    return;
  }
  recordedChunks = [];
  // Mono Opus at a low bitrate: great speech quality, ~2-4x smaller files than
  // the browser default, so voice notes still send on slow/mobile networks.
  // (This is where a native Lyra encoder would slot in on Android — see LYRA.md.)
  const recOpts = { audioBitsPerSecond: 24000 };
  if (typeof MediaRecorder.isTypeSupported === 'function'
      && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    recOpts.mimeType = 'audio/webm;codecs=opus';
  }
  try {
    mediaRecorder = new MediaRecorder(stream, recOpts);
  } catch {
    mediaRecorder = new MediaRecorder(stream); // fall back to browser defaults
  }
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
      await deliverMedia({ file, type: 'audio', mediaName: 'Mensagem de voz' });
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

// ------------------------------------------------------------------ contacts (agenda)
async function contactsModal() {
  const list = el('div', {});
  const newBtn = el('button', { class: 'btn-primary', style: 'margin-bottom:10px',
    onclick: () => contactFormModal(null, null, refresh) }, '＋ Novo contato');
  // Import straight from the phone's address book (Gmail-synced contacts too).
  // The SpeedVox app needs no phone number/SIM, so this just makes finding the
  // people you already know much faster.
  const agendaBtn = el('button', { class: 'btn-primary', style: 'margin-bottom:10px;background:var(--panel-3)',
    onclick: () => importFromAgenda(refresh) }, '📇 Adicionar pela agenda do celular');
  // Invite as many people as possible: opens WhatsApp / share sheet with my link.
  const inviteBtn = el('button', { class: 'btn-primary', style: 'margin-bottom:14px',
    onclick: shareMyLink }, '🔗 Convidar amigos (WhatsApp, SMS…)');
  const body = el('div', { class: 'modal-body' }, newBtn, agendaBtn, inviteBtn, list);
  const backdrop = modalShell('Contatos', body);

  async function refresh() {
    list.innerHTML = '';
    let contacts = [];
    try { ({ contacts } = await api.listContacts()); }
    catch { list.append(el('p', { class: 'auth-hint' }, 'Falha ao carregar contatos.')); return; }
    if (!contacts.length) {
      list.append(el('p', { class: 'auth-hint' }, 'Nenhum contato salvo ainda. Toque em "Novo contato".'));
      return;
    }
    for (const c of contacts) {
      const avatar = el('span', { class: 'avatar sm' });
      avatarBg(avatar, c.user && c.user.avatarUrl, c.displayName);
      const subParts = [];
      if (c.phone) subParts.push(c.phone);
      if (c.email) subParts.push(c.email);
      if (c.user) subParts.push('@' + c.user.username);
      const edit = el('button', { class: 'icon-btn', title: 'Editar',
        onclick: (e) => { e.stopPropagation(); contactFormModal(c, null, refresh); } }, '✎');
      const del = el('button', { class: 'icon-btn', title: 'Excluir',
        onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Excluir ${c.displayName}?`)) return;
          await api.deleteContact(c.id); refresh();
        } }, '🗑');
      const row = el('div', { class: 'user-result' }, avatar,
        el('div', { class: 'user-result-body' },
          el('div', { class: 'user-result-name' }, c.displayName),
          el('div', { class: 'user-result-sub' }, subParts.join(' · ') || 'Contato salvo')),
        edit, del);
      // Tapping a contact linked to a SpeedVox user opens the conversation.
      if (c.userId) {
        row.style.cursor = 'pointer';
        row.onclick = async () => {
          try {
            const { chat } = await api.openDirect(c.userId);
            state.chats.set(chat.id, chat);
            state.socket.emit('chat:join', { chatId: chat.id });
            backdrop.remove();
            await openChat(chat.id);
          } catch { toast('Não foi possível abrir a conversa'); }
        };
      }
      list.append(row);
    }
  }
  refresh();
}

// Import contacts from the phone's address book using the Contact Picker API
// (Android Chrome / installed PWA) or the native bridge. Picked e-mails are
// matched against SpeedVox users so you can start chatting in one tap; the rest
// can still be saved as plain contacts. The app uses no phone numbers, so the
// match is by e-mail (works great with Gmail-synced agendas).
async function importFromAgenda(onSaved) {
  const picker = navigator.contacts && navigator.contacts.select;
  if (!picker) {
    toast('A agenda do celular abre no Android (Chrome) ou no app instalado. Em outros aparelhos, adicione pelo e-mail em "Novo contato".');
    return;
  }
  let picked;
  try {
    picked = await navigator.contacts.select(['name', 'email', 'tel'], { multiple: true });
  } catch { return; } // cancelado ou permissão negada
  if (!picked || !picked.length) return;

  const entries = picked.map((c) => ({
    name: (c.name && c.name[0]) || (c.email && c.email[0]) || 'Contato',
    email: (c.email && c.email[0]) || '',
    phone: (c.tel && c.tel[0]) || '',
  }));
  const emails = entries.map((e) => e.email).filter(Boolean);
  const matched = new Map(); // email(lower) -> user
  try {
    const { users } = await api.matchUsers(emails);
    for (const u of users) if (u.email) matched.set(u.email.toLowerCase(), u);
  } catch { /* ignore: still let the user save plain contacts */ }

  const list = el('div', {});
  // "Marcar todos" — checkbox no topo que seleciona/desmarca todos de uma vez.
  const allCb = el('input', { type: 'checkbox', checked: '' });
  const head = el('label', { class: 'user-result', style: 'cursor:pointer;font-weight:600' },
    allCb, el('div', { class: 'user-result-body' }, el('div', { class: 'user-result-name' }, 'Marcar todos')));

  const rows = []; // { e, user, cb }
  for (const e of entries) {
    const user = e.email ? matched.get(e.email.toLowerCase()) : null;
    const sub = [e.email, e.phone].filter(Boolean).join(' · ') || 'Sem e-mail';
    const cb = el('input', { type: 'checkbox', checked: '' }); // já vem marcado
    rows.push({ e, user, cb });
    list.append(el('label', { class: 'user-result', style: 'cursor:pointer' },
      cb,
      el('div', { class: 'user-result-body' },
        el('div', { class: 'user-result-name' }, e.name + (user ? ' ✅' : '')),
        el('div', { class: 'user-result-sub' }, sub))));
  }
  allCb.onchange = () => rows.forEach((r) => { r.cb.checked = allCb.checked; });

  // Salvar TODOS os selecionados de uma vez (vincula quem já é usuário do app).
  const saveSel = el('button', { class: 'btn-primary' }, '💾 Salvar selecionados');
  saveSel.onclick = async () => {
    const chosen = rows.filter((r) => r.cb.checked);
    if (!chosen.length) { toast('Marque pelo menos um contato'); return; }
    saveSel.disabled = true; saveSel.textContent = 'Salvando…';
    let ok = 0;
    for (const r of chosen) {
      const payload = { displayName: r.e.name, email: r.e.email, phone: r.e.phone };
      if (r.user) payload.userId = r.user.id;
      try { await api.addContact(payload); ok += 1; }
      catch (err) { if (/já está salvo/i.test(err.message || '')) ok += 1; }
    }
    toast(`${ok} contato(s) salvos`);
    if (onSaved) onSaved();
    backdrop.remove();
  };

  // Convidar os selecionados. O WhatsApp não deixa disparar pra vários números
  // de uma vez (anti-spam), então abrimos a folha de compartilhamento UMA vez
  // com o seu link — você cola num grupo/lista de transmissão e chama todo mundo.
  const inviteSel = el('button', { class: 'btn-primary', style: 'background:#25d366' }, '🔗 Convidar selecionados');
  inviteSel.onclick = () => { shareMyLink(); };

  const body = el('div', { class: 'modal-body' },
    el('p', { class: 'auth-hint' }, `${entries.length} contato(s) da agenda. Quem já usa o SpeedVox aparece com ✅. Marque quem quiser e use os botões abaixo.`),
    head, list);
  const footer = el('div', { class: 'modal-footer', style: 'display:flex;gap:8px;flex-wrap:wrap' }, saveSel, inviteSel);
  const backdrop = modalShell('Adicionar pela agenda', body, footer);
}

// Add or edit a contact. `existing` = contact to edit; `prefill` = initial values
// (e.g. when saving someone from a chat); `onSaved` = callback to refresh a list.
function contactFormModal(existing, prefill, onSaved) {
  const data = existing || prefill || {};
  const name = el('input', { type: 'text', placeholder: 'Nome', value: data.displayName || '' });
  const phone = el('input', { type: 'text', placeholder: 'Telefone (opcional)', value: data.phone || '' });
  const email = el('input', { type: 'text', placeholder: 'E-mail (opcional)', value: data.email || '' });
  const note = el('input', { type: 'text', placeholder: 'Observação (opcional)', value: data.note || '' });
  const error = el('p', { class: 'auth-error' });

  const save = el('button', { class: 'btn-primary', onclick: async () => {
    if (!name.value.trim()) { error.textContent = 'Informe o nome do contato'; return; }
    const payload = {
      displayName: name.value.trim(),
      phone: phone.value.trim(),
      email: email.value.trim(),
      note: note.value.trim(),
    };
    try {
      if (existing) {
        await api.updateContact(existing.id, payload);
        toast('Contato atualizado');
      } else {
        if (prefill && prefill.userId) payload.userId = prefill.userId;
        await api.addContact(payload);
        toast('Contato salvo');
      }
      backdrop.remove();
      if (onSaved) onSaved();
    } catch (err) { error.textContent = err.message; }
  } }, existing ? 'Salvar alterações' : 'Salvar contato');

  const body = el('div', { class: 'modal-body' },
    el('div', { class: 'field-label' }, 'Nome'), name,
    el('div', { class: 'field-label' }, 'Telefone'), phone,
    el('div', { class: 'field-label' }, 'E-mail'), email,
    el('div', { class: 'field-label' }, 'Observação'), note,
    error, save);
  const backdrop = modalShell(existing ? 'Editar contato' : 'Novo contato', body);
  setTimeout(() => name.focus(), 50);
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
      setServerReachable(true);
      updateNetIndicator();
      avatarBg(node, up.url, name);
      onUploaded(up.url);
    } catch (err) { toast(uploadErrorMessage(err, 'image', file)); }
  };
  node.onclick = () => input.click();
  node.append(input);
  return node;
}

// Open my personal "Saved Messages" chat (Telegram-style).
async function openSavedMessages() {
  try {
    const { chat } = await api.openSaved();
    state.chats.set(chat.id, chat);
    state.socket.emit('chat:join', { chatId: chat.id });
    await openChat(chat.id);
  } catch { toast('Não foi possível abrir as Mensagens salvas'); }
}

// Copy a public invite link (Telegram t.me-style) that opens a chat with me.
function inviteUrl() {
  // Always point invites at the public site (works for the invitee even if I'm
  // running inside the native app, where location.origin is localhost).
  const u = state.me && state.me.username ? `?u=${encodeURIComponent(state.me.username)}` : '';
  return `https://chat.vibetube.com.br/${u}`;
}
function inviteText() {
  return `Vem conversar comigo no SpeedVox! Funciona em mensagens, ligações e até sem internet (rede mesh). Baixe/abra aqui: ${inviteUrl()}`;
}

// Invite the maximum number of people: open the phone's share sheet (WhatsApp,
// SMS, etc.). Falls back to copying the link.
async function shareMyLink() {
  const text = inviteText();
  if (navigator.share) {
    try { await navigator.share({ title: 'SpeedVox', text, url: inviteUrl() }); return; }
    catch { return; } // user cancelled the share sheet
  }
  const link = inviteUrl();
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Convite copiado: ' + link), () => prompt('Seu convite:', text));
  else prompt('Seu convite:', text);
}

// Invite a specific contact by phone number, straight to WhatsApp (most used in
// Brazil); assumes Brazil (DDI 55) when the number comes without a country code.
function inviteByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) { shareMyLink(); return; }
  const wa = digits.length <= 11 ? `55${digits}` : digits;
  window.open(`https://wa.me/${wa}?text=${encodeURIComponent(inviteText())}`, '_blank');
}

// Resolve a ?u=username deep link into an open conversation.
async function openUserByUsername(username) {
  const uname = String(username || '').toLowerCase().trim();
  if (!uname || uname === state.me.username) return;
  try {
    const { users } = await api.searchUsers(uname);
    const u = users.find((x) => x.username && x.username.toLowerCase() === uname) || users[0];
    if (!u) return toast('Usuário não encontrado: @' + uname);
    const { chat } = await api.openDirect(u.id);
    state.chats.set(chat.id, chat);
    state.socket.emit('chat:join', { chatId: chat.id });
    await openChat(chat.id);
  } catch { toast('Não foi possível abrir a conversa'); }
}

// Notification + Mesh settings — opened from the ⚙️ gear in the sidebar. This
// is where the call ring volume/vibration live (the user asked for a louder,
// adjustable ring) and where the Mesh network is made explicit and easy to find.
// Modal para definir/alterar o PIN do bloqueio (com opção de digital).
async function openAppLockSetup() {
  const pin1 = el('input', { class: 'select-input', type: 'password', inputmode: 'numeric',
    maxlength: '12', placeholder: 'Novo PIN (mín. 4 dígitos)', style: 'margin-bottom:10px' });
  const pin2 = el('input', { class: 'select-input', type: 'password', inputmode: 'numeric',
    maxlength: '12', placeholder: 'Repita o PIN', style: 'margin-bottom:10px' });

  const panic1 = el('input', { class: 'select-input', type: 'password', inputmode: 'numeric',
    maxlength: '12', placeholder: 'PIN de Pânico (opcional)', style: 'margin-bottom:10px' });
  const panic2 = el('input', { class: 'select-input', type: 'password', inputmode: 'numeric',
    maxlength: '12', placeholder: 'Repita o PIN de Pânico', style: 'margin-bottom:10px' });

  const bioAvail = await applock.biometricAvailable();
  const bioChk = el('input', { type: 'checkbox', checked: bioAvail ? '' : null });
  const bioRow = el('label', { style: 'display:flex;align-items:center;gap:8px;margin:4px 0 10px' },
    bioChk, el('span', {}, '🔑 Também desbloquear com a digital'));
  const err = el('div', { class: 'auth-error' });
  const save = el('button', { class: 'btn-primary', style: 'width:100%' }, 'Ativar bloqueio');

  const body = el('div', { class: 'modal-body' },
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      'Crie um PIN para abrir o SpeedVox. Ele fica guardado só no seu aparelho (em forma cifrada) — nem o servidor sabe seu PIN.'),
    pin1, pin2,
    el('hr', { style: 'border:0;border-top:1px dashed var(--border);margin:12px 0' }),
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      'Opcional: Defina um PIN de Pânico. Se você for obrigado a abrir o app, digite este PIN para simular um cofre falso e apagar os chats reais.'),
    panic1, panic2,
    el('hr', { style: 'border:0;border-top:1px dashed var(--border);margin:12px 0' }),
    bioAvail ? bioRow : el('p', { class: 'auth-hint' }, 'Este aparelho não oferece digital pelo navegador; o bloqueio usará o PIN.'),
    err, save);
  const bd = modalShell('🔒 Bloqueio do app', body);

  save.onclick = async () => {
    const p = pin1.value.trim();
    if (!/^\d{4,}$/.test(p)) { err.textContent = 'Use pelo menos 4 dígitos para o PIN (só números).'; return; }
    if (p !== pin2.value.trim()) { err.textContent = 'Os PINs não conferem.'; return; }

    const panic = panic1.value.trim();
    if (panic) {
      if (!/^\d{4,}$/.test(panic)) { err.textContent = 'Use pelo menos 4 dígitos para o PIN de Pânico.'; return; }
      if (panic === p) { err.textContent = 'O PIN de Pânico deve ser DIFERENTE do PIN normal.'; return; }
      if (panic !== panic2.value.trim()) { err.textContent = 'Os PINs de pânico não conferem.'; return; }
    }

    await applock.enable(p, { biometric: false });
    if (panic) {
      await applock.enablePanic(panic);
    }

    if (bioAvail && bioChk.checked) {
      try { await applock.biometricRegister(); } catch { toast('Digital não registrada; vale o PIN.'); }
    }
    bd.remove();
    toast('Bloqueio ativado ✅');
  };
  setTimeout(() => pin1.focus(), 100);
}

// Seção "Privacidade e segurança" das configurações (bloqueio + backup).
function securitySection() {
  const enabled = applock.isEnabled();
  const status = enabled
    ? `Ativado${applock.biometricEnabled() ? ' · com digital' : ' · só PIN'}`
    : 'Desativado';

  const lockBtns = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  if (enabled) {
    lockBtns.append(
      el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0',
        onclick: () => openAppLockSetup() }, 'Alterar PIN'),
      el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0;background:var(--danger)',
        onclick: (e) => {
          if (confirm('Desativar o bloqueio do app?')) { applock.disable(); toast('Bloqueio desativado'); e.target.closest('.modal-backdrop').remove(); }
        } }, 'Desativar'));
  } else {
    lockBtns.append(el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0',
      onclick: () => openAppLockSetup() }, 'Ativar bloqueio'));
  }

  return el('div', {},
    el('h3', { class: 'settings-section' }, '🔒 Privacidade e segurança'),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, `Bloqueio do app (PIN / digital): ${status}`),
      lockBtns),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Backup das conversas (criptografado)'),
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => exportBackup() },
        '💾 Fazer backup (com senha)')),
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      'O backup baixa um arquivo protegido por senha (.speedvox). Sem a senha, o arquivo é ilegível — nem nós conseguimos abrir. Guarde a senha em lugar seguro.'));
}

// Exporta as conversas carregadas num arquivo (backup local).
// Base64 seguro para arrays grandes (evita estourar a pilha do String.fromCharCode).
function bytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

// Cifra o backup com uma senha do usuário (PBKDF2 + AES-GCM). Sem a senha o
// arquivo é ilegível — nem o servidor, nem nós conseguimos abrir.
async function encryptBackupBlob(jsonStr, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iters = 210000;
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(jsonStr)));
  return JSON.stringify({
    app: 'SpeedVox', format: 'speedvox-encrypted-backup', v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iters, salt: bytesToB64(salt) },
    iv: bytesToB64(iv), ct: bytesToB64(ct),
  });
}

// Pequeno modal de senha; resolve com a senha (>=6) ou null se cancelar.
function askPassword(title, hint) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'password', placeholder: 'Senha do backup', style: 'width:100%' });
    const confirm = el('button', { class: 'btn-primary', style: 'margin-top:12px' }, 'Confirmar');
    const body = el('div', { class: 'modal-body' },
      el('h3', { style: 'margin-top:0' }, title),
      el('p', { class: 'auth-hint', style: 'margin-top:0' }, hint),
      input, confirm);
    const backdrop = modalShell('Backup seguro', body);
    let done = false;
    confirm.onclick = () => {
      const v = input.value;
      if (!v || v.length < 6) { toast('Use uma senha de ao menos 6 caracteres'); return; }
      done = true; backdrop.remove(); resolve(v);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm.click(); });
    const origRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = () => { origRemove(); if (!done) resolve(null); };
    setTimeout(() => input.focus(), 60);
  });
}

async function exportBackup() {
  try {
    const data = { app: 'SpeedVox', exportadoEm: new Date().toISOString(),
      usuario: state.me ? state.me.displayName : '', conversas: [] };
    for (const [chatId, chat] of state.chats) {
      const nome = chat.name || (chat.otherUser && chat.otherUser.displayName) || 'Conversa';
      const msgs = (state.messages.get(chatId) || []).filter((m) => !m.deleted).map((m) => {
        const autor = (chat.members || []).find((x) => x.id === m.senderId);
        return {
          de: autor ? autor.displayName : (m.senderId === (state.me && state.me.id) ? 'Você' : m.senderId),
          tipo: m.type,
          texto: m.type === 'text' ? displayText(m) : lastMessagePreview(m),
          em: new Date(m.createdAt).toISOString(),
        };
      });
      if (msgs.length) data.conversas.push({ nome, tipo: chat.type, mensagens: msgs });
    }

    // Backup agora é SEMPRE criptografado com senha (fecha o vazamento de
    // conversas em texto puro no arquivo exportado).
    const pass = await askPassword('Proteger o backup',
      'Escolha uma senha. Você vai precisar dela pra restaurar. Sem a senha o arquivo é ilegível — nem nós conseguimos abrir.');
    if (!pass) return;

    const encrypted = await encryptBackupBlob(JSON.stringify(data), pass);
    const blob = new Blob([encrypted], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `speedvox-backup-${new Date().toISOString().slice(0, 10)}.speedvox` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Backup criptografado ✅ (${data.conversas.length} conversa(s))`);
  } catch (e) { toast('Falha ao gerar backup'); }
}

function settingsModal() {
  // --- ring mode selector ---
  const ringSelect = el('select', { class: 'select-input' });
  for (const [v, label] of [
    ['loud', '🔊 Alto e chamativo'],
    ['normal', '🔉 Normal'],
    ['vibrate', '📳 Só vibrar'],
    ['silent', '🔕 Silencioso'],
  ]) {
    const o = el('option', { value: v }, label);
    if (v === ringtone.ringMode()) o.setAttribute('selected', '');
    ringSelect.append(o);
  }
  ringSelect.onchange = () => { ringtone.setRingMode(ringSelect.value); };

  // --- on-by-default boolean toggle helper (stores '1'/'0'; absent == on) ---
  const boolRow = (key, onText, offText) => {
    const isOn = () => localStorage.getItem(key) !== '0';
    const label = el('span', {}, isOn() ? onText : offText);
    const btn = el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0' },
      isOn() ? 'Desativar' : 'Ativar');
    btn.onclick = () => {
      const next = !isOn();
      localStorage.setItem(key, next ? '1' : '0');
      label.textContent = next ? onText : offText;
      btn.textContent = next ? 'Desativar' : 'Ativar';
    };
    return el('div', { style: 'display:flex;align-items:center;gap:12px' }, btn, label);
  };

  const testBtn = el('button', { class: 'btn-primary', style: 'background:var(--panel-3)' }, '🔔 Testar toque');
  testBtn.onclick = () => { ringtone.startIncoming(); setTimeout(() => ringtone.stop(), 3500); };

  // --- "chamada com app fechado" (FCM push) status indicator + Ativar/Testar ---
  // Shows, live, whether this device is registered to receive full-screen calls
  // while the app is closed, and lets the user re-run the registration on demand.
  const FCM_STATUS_LABELS = {
    ok:            { dot: '#22c55e', text: '✅ Registrado neste aparelho — chamadas chegam mesmo com o app fechado.' },
    browser:       { dot: '#9ca3af', text: 'ℹ️ Você está no navegador. Instale o app (APK) para receber chamadas com o app fechado.' },
    'no-auth':     { dot: '#f59e0b', text: '⚠️ Entre na sua conta para registrar este aparelho.' },
    'empty-token': { dot: '#f59e0b', text: '⏳ O Google ainda não devolveu o código. Toque em "Ativar/Testar" de novo em instantes.' },
    error:         { dot: '#ef4444', text: '❌ Não deu para registrar agora. Verifique a internet e tente novamente.' },
    checking:      { dot: '#3b82f6', text: '⏳ Verificando…' },
    unknown:       { dot: '#9ca3af', text: 'Toque em "Ativar/Testar" para verificar este aparelho.' },
  };
  const fcmDot = el('span', { style: 'display:inline-block;width:10px;height:10px;border-radius:50%;flex:0 0 auto' });
  const fcmText = el('div', { class: 'field-label', style: 'flex:1;margin:0' });
  const applyFcmStatus = (st) => {
    const info = FCM_STATUS_LABELS[st && st.status] || FCM_STATUS_LABELS.unknown;
    fcmDot.style.background = info.dot;
    fcmText.textContent = info.text;
  };
  applyFcmStatus(lastFcmPushStatus);
  const fcmTestBtn = el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0' }, 'Ativar/Testar');
  fcmTestBtn.onclick = async () => {
    fcmTestBtn.disabled = true;
    applyFcmStatus({ status: 'checking' });
    try {
      applyFcmStatus(await setupNativeCallPush());
    } finally {
      fcmTestBtn.disabled = false;
    }
  };
  // Live updates: periodic auto-retries (focus/visibility/timers) broadcast the
  // status too. The listener self-removes once this modal leaves the DOM.
  const onFcmStatus = (e) => {
    if (!fcmText.isConnected) { window.removeEventListener('speedvox:fcm-status', onFcmStatus); return; }
    applyFcmStatus(e.detail);
  };
  window.addEventListener('speedvox:fcm-status', onFcmStatus);
  // Kick a silent refresh on open; the result arrives via the event above.
  setupNativeCallPush().catch(() => {});

  // --- "Prontidão de chamada" estilo WhatsApp (só no app nativo) ---
  // Mostra o que já está liberado neste aparelho para a chamada tocar como o
  // WhatsApp e oferece o botão pra liberar o que falta (bateria / tela cheia).
  const readinessBox = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
  const renderReadiness = async () => {
    const cap = window.Capacitor || null;
    const plugin = cap && cap.Plugins ? cap.Plugins.SpeedvoxCall : null;
    readinessBox.textContent = '';
    if (!plugin || !plugin.getCallReadiness) {
      readinessBox.append(el('p', { class: 'auth-hint', style: 'margin:0' },
        'ℹ️ Abra pelo app (APK) para ver e liberar tudo que faz a chamada tocar como no WhatsApp. No navegador isso não se aplica.'));
      return;
    }
    let r = {};
    try { r = await plugin.getCallReadiness(); } catch {}
    const line = (ok, label, fixLabel, fixFn) => {
      const row = el('div', { style: 'display:flex;align-items:center;gap:8px' },
        el('span', { style: 'flex:0 0 auto' }, ok ? '✅' : '⚠️'),
        el('div', { class: 'field-label', style: 'flex:1;margin:0' }, label));
      if (!ok && fixFn) {
        const b = el('button', { class: 'btn-primary', style: 'padding:6px 12px;margin:0' }, fixLabel);
        b.onclick = async () => { try { await fixFn(); } catch {} setTimeout(renderReadiness, 1500); };
        row.append(b);
      }
      return row;
    };
    readinessBox.append(
      line(r.notifications, 'Notificações permitidas', null, null),
      line(r.overlay, 'Abrir a tela de chamada por cima (aparecer sobre apps)', 'Liberar', () => plugin.requestOverlayPermission && plugin.requestOverlayPermission()),
      line(r.fullScreen, 'Abrir em tela cheia (Android 14+)', 'Liberar', () => plugin.openFullScreenIntentSettings()),
      line(r.battery, 'Não congelar no modo economia de bateria', 'Liberar', () => plugin.requestBatteryOptimizationExemption()),
    );
  };
  renderReadiness();

  // --- mesh status line + toggle (make the mesh feature explicit) ---
  const peers = state.mesh ? state.mesh.status().peers : 0;
  const meshState = !state.mesh ? 'indisponível neste aparelho'
    : state.mesh.enabled ? (peers > 0 ? `ativo · ${peers} aparelho(s) por perto` : 'ativo · procurando aparelhos por perto…')
    : 'desativado';

  const body = el('div', { class: 'modal-body' },
    el('h3', { class: 'settings-section' }, '🔔 Notificações e chamadas'),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Toque de chamada'), ringSelect),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Vibrar ao receber chamada'),
      boolRow('speedvox_vibrate', 'Ativado', 'Desativado')),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, '📳 Vibração nos toques (haptics)'),
      boolRow('speedvox_haptics', 'Ativado', 'Desativado')),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Som ao chegar mensagem (app aberto)'),
      boolRow('speedvox_msg_sound', 'Ativado', 'Desativado')),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, '🎙️ Limpeza de Ruído no Microfone (Web Audio)'),
      boolRow('speedvox_noise_suppression', 'Ativado', 'Desativado')),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, '🎧 Qualidade de Áudio Estúdio (Opus Lossless)'),
      boolRow('speedvox_studio_audio', 'Ativado', 'Desativado')),
    el('div', { class: 'field-row' }, testBtn),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, '📞 Chamada com o app fechado (este aparelho)'),
      fcmTestBtn),
    el('div', { class: 'field-row', style: 'display:flex;align-items:center;gap:10px' },
      fcmDot, fcmText),
    el('p', { class: 'auth-hint' },
      'Mesmo com o app fechado, chamadas e mensagens chegam como notificação no celular (com som e vibração do sistema). Você fica conectado até tocar em Sair.'),

    el('h3', { class: 'settings-section' }, '📞 Prontidão de chamada (estilo WhatsApp)'),
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      'Para a chamada tocar com o app no bolso — tela de bloqueio, vibração e som como uma ligação de verdade — o Android precisa liberar estes itens neste aparelho:'),
    readinessBox,

    securitySection(),

    el('h3', { class: 'settings-section' }, '📡 Rede Mesh (funciona sem internet)'),
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      'O SpeedVox conversa direto entre aparelhos por perto (Bluetooth/Wi-Fi Direct), mesmo sem internet — é o que torna ele superior ao WhatsApp e ao Telegram em apagões e emergências.'),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'width:100%;font-size:16px;padding:14px',
        onclick: async () => { await connectMeshNow(); backdrop.remove(); } },
        '📡 Conectar à Rede Mesh agora')),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, `Estado: ${meshState}`),
      state.mesh ? meshToggleRow() : el('span', {}, '—')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); openOfflineMode(); } }, '📡 Modo Offline / aparelhos por perto')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); openMeshDiagnostics(); } }, '🩺 Diagnóstico da Rede Mesh')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary sos-btn', onclick: () => { backdrop.remove(); sendSOS(); } }, '🆘 Emergência (SOS)')));

  const backdrop = modalShell('Configurações', body);
}

function profileModal() {
  const formatVirtualNumber = (num) => {
    if (!num) return 'Não atribuído';
    if (num.length === 11) {
      return `+55 (${num.slice(0, 2)}) ${num.slice(2, 7)}-${num.slice(7)}`;
    }
    return num;
  };

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
      el('div', { class: 'field-label' }, 'Número Virtual'),
      el('div', {}, formatVirtualNumber(state.me.virtualNumber))),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); openSavedMessages(); } }, '🔖 Mensagens salvas')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); showStarredMessages(); } }, '★ Mensagens favoritas')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: shareMyLink }, '🔗 Compartilhar meu link')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); privacyModal(); } }, '🔒 Privacidade')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); linkDeviceModal(); } }, '📱 Vincular um dispositivo')),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Baixar mídias automaticamente'),
      autoDownloadRow()),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Modo mesh (resiliência em apagão)'),
      meshToggleRow()),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); openOfflineMode(); } }, '📡 Modo Offline')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)', onclick: () => { backdrop.remove(); openMeshDiagnostics(); } }, '🩺 Diagnóstico Mesh')),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary sos-btn', onclick: () => { backdrop.remove(); sendSOS(); } },
        '🆘 Emergência (SOS)')));
  const footer = el('div', { class: 'modal-footer' }, save);
  const backdrop = modalShell('Perfil', body, footer);
}

async function privacyModal() {
  let p;
  try { p = (await api.getPrivacy()).privacy; } catch { return toast('Falha ao carregar privacidade'); }
  const select = (value, options) => {
    const s = el('select', { class: 'select-input' });
    for (const [v, label] of options) {
      const o = el('option', { value: v }, label);
      if (v === value) o.setAttribute('selected', '');
      s.append(o);
    }
    return s;
  };
  const choices = [['everyone', 'Todos'], ['contacts', 'Meus contatos'], ['nobody', 'Ninguém']];
  const lastSeen = select(p.lastSeen, choices);
  const groups = select(p.groups, choices);
  const photo = select(p.photo, choices);
  const about = select(p.about, choices);
  const rr = el('input', { type: 'checkbox' });
  if (p.readReceipts) rr.setAttribute('checked', '');

  const save = el('button', { class: 'btn-primary', onclick: async () => {
    await api.setPrivacy({ lastSeen: lastSeen.value, groups: groups.value, photo: photo.value, about: about.value, readReceipts: rr.checked });
    backdrop.remove();
    toast('Privacidade atualizada');
  } }, 'Salvar');

  const body = el('div', { class: 'modal-body' },
    el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, 'Visto por último e online'), lastSeen),
    el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, 'Foto do perfil'), photo),
    el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, 'Recado'), about),
    el('div', { class: 'field-row' }, el('div', { class: 'field-label' }, 'Quem pode me adicionar a grupos'), groups),
    el('label', { class: 'field-row', style: 'display:flex;align-items:center;gap:10px;cursor:pointer' },
      rr, el('span', {}, 'Confirmações de leitura (recíproco)')),
    el('p', { class: 'auth-hint' }, 'Se você desativar as confirmações de leitura, também não verá as dos outros.'));
  const footer = el('div', { class: 'modal-footer' }, save);
  const backdrop = modalShell('Privacidade', body, footer);
}

// Logged-in device approving a code shown on a new device.
function linkDeviceModal() {
  const input = el('input', { type: 'text', placeholder: 'Código exibido no outro aparelho', style: 'text-transform:uppercase;letter-spacing:3px;text-align:center;font-size:20px' });
  const approve = el('button', { class: 'btn-primary', onclick: async () => {
    const code = input.value.trim().toUpperCase();
    if (code.length < 6) return toast('Informe o código');
    try { await api.linkApprove(code); backdrop.remove(); toast('Dispositivo vinculado'); }
    catch (e) { toast(e.message || 'Código inválido'); }
  } }, 'Vincular');
  const body = el('div', { class: 'modal-body' },
    el('p', { class: 'auth-hint', style: 'margin-bottom:14px' }, 'No novo aparelho, abra o SpeedVox e toque em "Vincular dispositivo". Digite aqui o código mostrado.'),
    input);
  const footer = el('div', { class: 'modal-footer' }, approve);
  const backdrop = modalShell('Vincular um dispositivo', body, footer);
  setTimeout(() => input.focus(), 50);
}

async function showStarredMessages() {
  let messages = [];
  try { messages = (await api.starredMessages()).messages; } catch { return toast('Falha ao carregar favoritas'); }
  const body = el('div', { class: 'modal-body' });
  if (!messages.length) body.append(el('p', { class: 'auth-hint' }, 'Nenhuma mensagem favorita ainda.'));
  for (const m of messages) {
    const chat = state.chats.get(m.chatId);
    const row = el('div', { class: 'user-result', onclick: () => { backdrop.remove(); if (chat) openChat(m.chatId).then(() => scrollToMessage(m.id)); } },
      el('div', { class: 'user-result-body' },
        el('div', { class: 'user-result-name' }, chat ? chat.title : 'Conversa'),
        el('div', { class: 'user-result-sub' }, m.encrypted ? '🔒 mensagem cifrada' : lastMessagePreview(m))),
      el('button', { class: 'icon-btn', title: 'Desfavoritar', onclick: async (e) => {
        e.stopPropagation(); await api.starMessage(m.id, false); row.remove();
      } }, '★'));
    body.append(row);
  }
  const backdrop = modalShell('Mensagens favoritas', body);
}

// Per-device media auto-download preference (like WhatsApp). On by default.
function autoDownloadOn() { return localStorage.getItem('speedvox_autodownload') !== '0'; }

function autoDownloadRow() {
  const on = autoDownloadOn();
  const label = el('span', {}, on ? 'Ativado' : 'Só ao tocar em "Baixar"');
  const btn = el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0' },
    on ? 'Desativar' : 'Ativar');
  btn.onclick = () => {
    const next = !autoDownloadOn();
    localStorage.setItem('speedvox_autodownload', next ? '1' : '0');
    label.textContent = next ? 'Ativado' : 'Só ao tocar em "Baixar"';
    btn.textContent = next ? 'Desativar' : 'Ativar';
    if (state.activeChatId) renderMessages();
    toast(next ? 'Mídias baixam automaticamente' : 'Mídias só baixam quando você pedir');
  };
  return el('div', { style: 'display:flex;align-items:center;gap:12px' }, btn, label);
}

function meshToggleRow() {
  const label = el('span', {}, state.mesh.enabled ? 'Ativado' : 'Desativado');
  const btn = el('button', { class: 'btn-primary', style: 'padding:8px 16px;margin:0' },
    state.mesh.enabled ? 'Desativar' : 'Ativar');
  btn.onclick = async () => {
    state.mesh.setEnabled(!state.mesh.enabled);
    label.textContent = state.mesh.enabled ? 'Ativado' : 'Desativado';
    btn.textContent = state.mesh.enabled ? 'Desativar' : 'Ativar';
    if (state.mesh.enabled) {
      // Try to peer with everyone we currently know is online.
      for (const [uid, p] of state.presence) if (p.online) state.mesh.connect(uid);
      // Start the native zero-infrastructure transport, if present.
      if (state.meshNearby && state.meshNearby.available) { try { await state.meshNearby.start(); } catch {} }
      const extra = state.meshNearby && state.meshNearby.available ? ' (Bluetooth/Wi-Fi Direct ativo)' : '';
      toast('Modo mesh ativado: mensagens podem trafegar peer-to-peer' + extra);
    } else if (state.meshNearby && state.meshNearby.available) {
      try { await state.meshNearby.stop(); } catch {}
    }
  };
  return el('div', { style: 'display:flex;align-items:center;gap:12px' }, btn, label);
}

// One-tap "join the mesh": turns on mesh, starts the zero-infrastructure radio
// (Bluetooth/Wi-Fi Direct) and links up with everyone currently reachable. This
// is the button everyone in a group presses in a blackout so they can keep
// talking to each other with no internet and no cell towers.
async function connectMeshNow() {
  if (!state.mesh) { toast('Rede mesh indisponível neste aparelho'); return; }
  if (!state.mesh.enabled) state.mesh.setEnabled(true);
  for (const [uid, p] of state.presence) if (p.online) state.mesh.connect(uid);
  if (state.meshNearby && state.meshNearby.available) { try { await state.meshNearby.start(); } catch {} }
  updateNetIndicator();
  const extra = state.meshNearby && state.meshNearby.available ? ' Bluetooth/Wi-Fi Direct ativo.' : '';
  toast('Conectado à Rede Mesh.' + extra + ' Mensagens trafegam entre aparelhos próximos, sem internet.');
}

// ------------------------------------------------------------------ offline mode UI
async function openOfflineMode() {
  const online = Boolean(state.socket && state.socket.connected);
  const native = offline.nativeAvailable(state.meshNearby);
  const peers = state.mesh ? state.mesh.status().peers : 0;

  let stateText;
  if (online) stateText = 'Você está online. O modo offline está de reserva.';
  else if (state.mesh && state.mesh.enabled && peers > 0) stateText = `Modo Mesh ativo. ${peers} dispositivo(s) próximo(s).`;
  else if (state.mesh && state.mesh.enabled) stateText = 'Modo Mesh ativo. Procurando pessoas próximas…';
  else stateText = 'Sem internet e modo mesh desligado.';

  const body = el('div', { class: 'modal-body' },
    el('div', { class: 'offline-state' }, stateText),
    el('div', { class: 'field-row' },
      el('div', { class: 'field-label' }, 'Modo mesh (resiliência em apagão)'),
      meshToggleRow()),
    el('p', { class: 'auth-hint' },
      'No modo offline, o SpeedVox tenta falar diretamente com aparelhos próximos '
      + '(sem internet), repassando mensagens de aparelho em aparelho até chegar ao destino.'),
    el('div', { class: 'offline-transport' },
      el('strong', {}, 'Transporte por perto: '),
      native ? 'Disponível (Bluetooth / Wi-Fi Direct)' : 'Indisponível neste dispositivo'),
    native ? '' : el('p', { class: 'auth-hint' },
      'No navegador, o alcance real por Bluetooth/Wi-Fi Direct depende do app Android '
      + 'instalado (APK). Aqui você já pode gerar sua identidade e rodar o diagnóstico.'),
    el('div', { class: 'field-row' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)',
        onclick: () => { backdrop.remove(); openMeshDiagnostics(); } }, '🩺 Abrir Diagnóstico Mesh')));
  const backdrop = modalShell('Modo Offline', body);
}

async function openMeshDiagnostics() {
  const body = el('div', { class: 'modal-body' }, el('p', { class: 'auth-hint' }, 'Carregando diagnóstico…'));
  const backdrop = modalShell('Diagnóstico Mesh', body);

  const row = (k, v) => el('div', { class: 'diag-row' },
    el('span', { class: 'diag-k' }, k), el('span', { class: 'diag-v' }, v));

  let id = null;
  try { id = await offline.ensureIdentity(state.me.displayName); }
  catch (e) { body.innerHTML = ''; body.append(el('p', { class: 'auth-hint' },
    'Este dispositivo não suporta a criptografia necessária (Ed25519/X25519). '
    + 'Atualize o navegador/WebView do Android. Detalhe: ' + ((e && e.message) || e))); return; }

  const pid = offline.publicIdentity();
  const meshStatus = state.mesh ? state.mesh.status() : { peers: 0, held: 0, enabled: false };
  const native = offline.nativeAvailable(state.meshNearby);
  const be = await offline.meshBackendInfo();

  // Crypto self-test (the key signal for "does my phone work").
  const test = await offline.cryptoSelfTest();
  const testNode = el('div', { class: 'diag-test' },
    el('div', { class: 'diag-test-head' }, test.ok ? '✅ Criptografia OK neste aparelho' : '❌ Falha de criptografia'),
    ...test.steps.map((s) => el('div', { class: 'diag-step' }, (s.ok ? '✓ ' : '✗ ') + s.name)),
    test.error ? el('div', { class: 'diag-step' }, 'Erro: ' + test.error) : '');

  body.innerHTML = '';
  body.append(
    el('h4', { class: 'diag-h' }, 'Identidade local'),
    row('deviceId', pid ? pid.deviceId : '—'),
    row('Chave pública (assinatura)', pid ? pid.signPub.slice(0, 24) + '…' : '—'),
    row('Chave pública (troca)', pid ? pid.kxPub.slice(0, 24) + '…' : '—'),

    el('h4', { class: 'diag-h' }, 'Criptografia (autoteste)'),
    testNode,

    el('h4', { class: 'diag-h' }, 'Malha (neste app)'),
    row('Modo mesh', meshStatus.enabled ? 'Ativado' : 'Desligado'),
    row('Peers conectados', String(meshStatus.peers)),
    row('Mensagens retidas (store-and-forward)', String(meshStatus.held || 0)),
    row('Transporte por perto (BLE/Wi-Fi Direct)', native ? 'Disponível' : 'Indisponível (requer app Android)'),

    el('h4', { class: 'diag-h' }, 'Backend mesh'),
    row('Status', be.status ? (be.status.enabled ? 'ativo' : 'desativado') : 'inacessível'),
    row('Sync', be.status ? (be.status.syncEnabled ? 'ativo' : 'desativado') : '—'),
    row('TTL máx. / lote máx.', be.config ? `${be.config.maxTTL} / ${be.config.maxBatchSize}` : '—'),

    el('h4', { class: 'diag-h' }, 'Nearby Mesh (offline)'),
    nearbyControl(backdrop),

    el('div', { class: 'diag-actions' },
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)',
        onclick: async () => { backdrop.remove(); openMeshDiagnostics(); } }, '🔄 Rodar de novo'),
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)',
        onclick: async () => {
          try { await navigator.clipboard.writeText(JSON.stringify(pid)); toast('Identidade pública copiada'); }
          catch { toast('Não foi possível copiar'); }
        } }, '📋 Copiar identidade pública'),
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)',
        onclick: async () => {
          const r = await offline.registerDevice().catch((e) => ({ error: e.message }));
          toast(r && r.ok ? 'Dispositivo registrado no servidor' : ('Falha: ' + ((r && r.error) || 'erro')));
        } }, '☁️ Registrar no servidor'),
      el('button', { class: 'btn-primary', style: 'background:var(--panel-3)',
        onclick: async () => {
          try {
            const r = await offline.syncPull();
            toast(`Sincronizado: ${r.verified}/${r.pulled} mensagem(ns) verificada(s) do servidor`);
          } catch (e) { toast('Falha ao sincronizar: ' + ((e && e.message) || e)); }
        } }, '🔁 Sincronizar mesh'),
      el('button', { class: 'btn-primary sos-btn',
        onclick: async () => {
          if (!confirm('Resetar a identidade offline? Isto gera novas chaves e um novo deviceId.')) return;
          await offline.resetIdentity(state.me.displayName);
          backdrop.remove(); openMeshDiagnostics();
        } }, '🗑️ Resetar identidade')));
}

// Live "Iniciar Nearby Mesh" control: starts advertising+discovery via the
// native plugin and shows the state (running, peers, errors). On the web it is
// disabled with an explanation, since BLE/Wi-Fi Direct need the Android app.
function nearbyControl(backdrop) {
  const wrap = el('div', { class: 'diag-test' });
  const status = el('div', { class: 'diag-test-head' }, '—');
  const detail = el('div', { class: 'diag-step' }, '');
  const ctrl = state.meshNearby;
  const available = offline.nativeAvailable(ctrl);

  const btn = el('button', { class: 'btn-primary', style: 'margin-top:8px' },
    available ? '▶ Iniciar Nearby Mesh' : 'Indisponível neste dispositivo');
  if (!available) btn.setAttribute('disabled', '');

  const refresh = () => {
    if (!available) {
      status.textContent = '⚪ Indisponível (requer o app Android — APK)';
      detail.textContent = 'No navegador não há acesso a Bluetooth/Wi-Fi Direct.';
      return;
    }
    const running = Boolean(ctrl.running);
    const peers = state.mesh ? state.mesh.status().peers : 0;
    status.textContent = running ? '🟢 Anunciando e procurando aparelhos…' : '⚪ Parado';
    detail.textContent = running
      ? `startAdvertising + startDiscovery ativos · ${peers} aparelho(s) conectado(s)`
        + (ctrl.lastError ? ` · erro: ${ctrl.lastError}` : '')
      : 'Toque para anunciar este aparelho e procurar outros por perto.';
    btn.textContent = running ? '⏹ Parar Nearby Mesh' : '▶ Iniciar Nearby Mesh';
  };

  btn.onclick = async () => {
    if (!available) return;
    try {
      if (ctrl.running) {
        await ctrl.stop();
      } else {
        if (state.mesh && !state.mesh.enabled) state.mesh.setEnabled(true);
        await ctrl.start();
      }
    } catch (e) { toast('Falha no Nearby: ' + ((e && e.message) || e)); }
    refresh();
  };

  // Live updates while the screen is open.
  refresh();
  const timer = setInterval(() => {
    if (!backdrop || !backdrop.isConnected) { clearInterval(timer); return; }
    refresh();
  }, 1500);

  wrap.append(status, detail, btn);
  return wrap;
}

// Dropdown to choose the disappearing-messages timer for a chat.
// Atalho: abre um modalzinho só pra ligar/desligar mensagens temporárias.
function quickDisappearing(chat) {
  modalShell('⏱ Mensagens temporárias', el('div', { class: 'modal-body' },
    el('p', { class: 'auth-hint', style: 'margin-top:0' },
      'As mensagens novas desta conversa somem automaticamente depois do tempo escolhido.'),
    disappearingRow(chat)));
}

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

  // Block / unblock (direct chats only).
  let blockBtn = '';
  if (!isGroup && chat.otherUser) {
    const setLabel = (b) => b ? 'Desbloquear contato' : 'Bloquear contato';
    blockBtn = el('button', { class: 'btn-primary', style: 'background:var(--panel-3);margin-top:10px' },
      setLabel(chat.blocked));
    blockBtn.onclick = async () => {
      if (chat.blocked) await api.unblockUser(chat.otherUser.id);
      else await api.blockUser(chat.otherUser.id);
      const { chat: updated } = await api.getChat(chat.id);
      state.chats.set(updated.id, updated);
      chat.blocked = updated.blocked;
      blockBtn.textContent = setLabel(updated.blocked);
      updateComposerState(updated);
      toast(updated.blocked ? 'Contato bloqueado' : 'Contato desbloqueado');
    };
  }

  // Save the other person to my contacts (direct chats only).
  let saveContactBtn = '';
  if (!isGroup && chat.otherUser) {
    saveContactBtn = el('button', { class: 'btn-primary', style: 'background:var(--panel-3);margin-top:10px',
      onclick: () => contactFormModal(null, {
        displayName: chat.otherUser.displayName,
        email: chat.otherUser.email || '',
        userId: chat.otherUser.id,
      }) }, '＋ Salvar nos contatos');
  }

  // Verificar identidade (número de segurança), estilo Signal — só chat direto.
  let safetyBtn = '';
  if (!isGroup && chat.otherUser) {
    safetyBtn = el('button', { class: 'btn-primary', style: 'background:var(--panel-3);margin-top:10px',
      onclick: () => openSafetyNumber(chat) }, '🔐 Número de segurança (verificar)');
  }

  const body = el('div', { class: 'modal-body' },
    big,
    titleNode,
    el('p', { class: 'auth-hint' }, presenceText(chat)),
    el('div', { style: 'margin-top:16px' }, disappearingRow(chat)),
    el('div', { class: 'field-label' }, isGroup ? `${chat.members.length} participantes` : 'Contato'),
    members,
    addBtn,
    saveContactBtn,
    safetyBtn,
    blockBtn,
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

// ------------------------------------------------------------------ status / stories
const STATUS_COLORS = ['#075E54', '#7E57C2', '#C2185B', '#1565C0', '#2E7D32', '#EF6C00', '#37474F'];

async function refreshStatusIndicator() {
  try {
    const feed = await api.statusFeed();
    const unviewed = feed.contacts.some((g) => g.hasUnviewed);
    $('#status-btn').classList.toggle('has-status', unviewed);
  } catch { /* ignore */ }
}

async function openStatusPanel() {
  let feed;
  try { feed = await api.statusFeed(); } catch (e) { return toast('Falha ao carregar status'); }

  const body = el('div', { class: 'modal-body' });

  // My status row.
  const myAvatar = el('span', { class: 'avatar' });
  avatarBg(myAvatar, state.me.avatarUrl, state.me.displayName);
  const myRow = el('div', { class: 'user-result' },
    el('span', { class: `status-ring${feed.me.length ? ' seen' : ''}` }, myAvatar),
    el('div', { class: 'user-result-body' },
      el('div', { class: 'user-result-name' }, 'Meu status'),
      el('div', { class: 'user-result-sub' },
        feed.me.length ? `${feed.me.length} atualização(ões) · toque para ver` : 'Toque para adicionar')));
  myRow.onclick = () => {
    backdrop.remove();
    if (feed.me.length) viewStatuses(feed.me, state.me, true);
    else statusComposer();
  };
  const addBtn = el('button', { class: 'icon-btn', title: 'Adicionar status', style: 'font-size:20px',
    onclick: (e) => { e.stopPropagation(); backdrop.remove(); statusComposer(); } }, '＋');
  myRow.append(addBtn);
  body.append(myRow);

  // Contacts' statuses.
  if (feed.contacts.length) {
    body.append(el('div', { class: 'field-label', style: 'margin-top:14px' }, 'Atualizações recentes'));
    for (const g of feed.contacts) {
      const av = el('span', { class: 'avatar' });
      avatarBg(av, g.user.avatarUrl, g.user.displayName);
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

function compressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        const maxW = 1280;
        if (width > maxW) {
          height = Math.round((height * maxW) / width);
          width = maxW;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          if (blob) {
            const compressedFile = new File([blob], file.name.replace(/\.[^/.]+$/, ".webp"), {
              type: 'image/webp',
              lastModified: Date.now()
            });
            resolve(compressedFile);
          } else {
            resolve(file);
          }
        }, 'image/webp', 0.75);
      };
      img.onerror = () => resolve(file);
    };
    reader.onerror = () => resolve(file);
  });
}

function checkVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration);
    };
    video.onerror = () => {
      resolve(0);
    };
  });
}

function statusComposer() {
  let chosenColor = STATUS_COLORS[0];
  let pendingMedia = null; // { url, type: 'image' | 'video' }

  const preview = el('div', { class: 'status-compose-preview', style: `background:${chosenColor}` });
  const textInput = el('textarea', { class: 'status-compose-text', placeholder: 'Digite um status', rows: '4' });
  textInput.oninput = () => {
    if (!pendingMedia) preview.textContent = textInput.value;
  };
  preview.append(textInput);

  const swatches = el('div', { class: 'status-swatches' });
  for (const c of STATUS_COLORS) {
    swatches.append(el('button', { class: 'swatch', style: `background:${c}`,
      onclick: () => {
        chosenColor = c;
        if (!pendingMedia) {
          preview.style.background = c;
        }
      } }));
  }

  const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,video/mp4,video/webm', style: 'display:none' });
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    fileInput.value = '';
    if (!f) return;

    const isImage = f.type.startsWith('image/');
    const isVideo = f.type.startsWith('video/');

    if (!isImage && !isVideo) {
      return toast('Formato não suportado. Escolha uma foto ou vídeo.');
    }

    if (isImage) {
      if (f.size > 2 * 1024 * 1024) {
        return toast('Imagem muito pesada. Use uma foto de até 2 MB.');
      }
    } else if (isVideo) {
      if (f.size > 8 * 1024 * 1024) {
        return toast('Vídeo muito pesado para Status. Use um vídeo de até 8 MB e 15 segundos.');
      }
      toast('Validando tempo do vídeo...');
      const duration = await checkVideoDuration(f);
      if (duration > 15.5) {
        return toast('Vídeo muito longo. Use um vídeo de até 15 segundos.');
      }
    }

    try {
      toast('Carregando arquivo...');
      let fileToUpload = f;

      if (isImage) {
        toast('Redimensionando foto...');
        fileToUpload = await compressImage(f);
      }

      const up = await api.upload(fileToUpload);
      setServerReachable(true);
      updateNetIndicator();
      pendingMedia = { url: up.url, type: isImage ? 'image' : 'video' };

      preview.style.background = '#000';
      preview.style.backgroundImage = 'none';
      preview.querySelectorAll('video').forEach(el => el.remove());

      if (isImage) {
        preview.style.backgroundImage = `url(${up.url})`;
        preview.style.backgroundSize = 'cover';
        preview.style.backgroundPosition = 'center';
      } else {
        const vidPreview = el('video', {
          src: up.url,
          autoplay: true,
          loop: true,
          muted: true,
          style: 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0;z-index:0'
        });
        preview.prepend(vidPreview);
      }

      textInput.placeholder = 'Legenda (opcional)';
      textInput.value = '';
      textInput.style.position = 'relative';
      textInput.style.zIndex = '1';
      preview.textContent = '';
      preview.append(textInput);
      toast('Arquivo carregado com sucesso!');
    } catch (err) {
      toast(uploadErrorMessage(err, isVideo ? 'video' : 'image', f));
    }
  };

  const photoBtn = el('button', { class: 'icon-btn', title: 'Adicionar foto/vídeo', style: 'font-size:20px', onclick: () => fileInput.click() }, '📷');
  const post = el('button', { class: 'btn-primary', onclick: async () => {
    try {
      if (pendingMedia) {
        await api.postStatus({
          type: pendingMedia.type,
          mediaUrl: pendingMedia.url,
          body: textInput.value.trim() || undefined
        });
      } else {
        if (!textInput.value.trim()) return toast('Escreva algo ou escolha uma foto/vídeo');
        await api.postStatus({
          type: 'text',
          body: textInput.value.trim(),
          bgColor: chosenColor
        });
      }
      backdrop.remove();
      toast('Status publicado');
      refreshStatusIndicator();
      if (state.chatFolder === 'status') renderStatusList();
    } catch (err) {
      toast('Falha ao publicar: ' + err.message);
    }
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

  function close() {
    if (timer) clearTimeout(timer);
    overlay.remove();
    refreshStatusIndicator();
    if (state.chatFolder === 'status') renderStatusList();
    else openStatusPanel();
  }

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
    } else if (s.type === 'video' && s.mediaUrl) {
      content.style.background = '#000';
      const videoEl = el('video', {
        class: 'status-img',
        src: mediaUrl(s.mediaUrl),
        autoplay: true,
        playsinline: true,
        controls: false,
        style: 'max-width:100%;max-height:100%;object-fit:contain;'
      });
      content.append(videoEl);
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

let lastNetMode = null;
let lastMeshFallbackState = null;

function updateNetIndicator() {
  const ind = $('#net-indicator');
  if (!ind) return;

  const isHealthy = cachedServerReachable();
  const socketConnected = socketIsConnected();
  const meshOn = Boolean(state.mesh && state.mesh.enabled && state.mesh.status().peers > 0);

  let currentMode = 'offline';
  let colorClass = 'offline';
  let titleText = 'Reconectando…';

  if (isHealthy) {
    if (socketConnected) {
      currentMode = 'internet';
      colorClass = 'online';
      titleText = meshOn ? `Online + ${state.mesh.status().peers} peers mesh` : 'Online';
    } else {
      currentMode = 'connecting';
      colorClass = 'online';
      titleText = 'Online · reconectando tempo real';
    }
  } else {
    if (meshOn) {
      currentMode = 'mesh';
      colorClass = 'connecting';
      titleText = `Servidor offline · ${state.mesh.status().peers} peers via mesh`;
    } else {
      currentMode = 'offline';
      colorClass = 'offline';
      titleText = 'Sem conexão';
    }
  }

  // Console logging transitions
  if (currentMode !== lastNetMode) {
    lastNetMode = currentMode;
    console.log(`NET_MODE=${currentMode}`);
  }

  const currentMeshFallback = Boolean(!isHealthy && state.mesh && state.mesh.enabled);
  if (currentMeshFallback !== lastMeshFallbackState) {
    lastMeshFallbackState = currentMeshFallback;
    console.log(currentMeshFallback ? 'MESH_FALLBACK_ENABLED' : 'MESH_FALLBACK_DISABLED');
  }

  ind.className = `net-indicator ${colorClass}`;
  ind.title = titleText;
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
  try { state.iceServers = (await (await fetch(apiUrl('/api/ice'), { cache: 'no-store' })).json()).iceServers; } catch { state.iceServers = null; }

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
  hasInternetConnection({ force: true, timeoutMs: 2500 }).catch(() => {});

  // Background monitoring every 5 seconds to guarantee recovery of connection status
  setInterval(async () => {
    const isHealthy = await hasInternetConnection({ force: true, timeoutMs: 2500 });
    if (isHealthy) {
      if (state.socket && !state.socket.connected) {
        state.socket.connect();
      }
    }
    updateNetIndicator();
  }, 5000);

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
  setupNativeCallPush();
  setTimeout(setupNativeCallPush, 3000);
  setTimeout(setupNativeCallPush, 10000);
  window.addEventListener('focus', () => setupNativeCallPush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') setupNativeCallPush();
  });
  setupAndroidBackButton();
  refreshStatusIndicator();
}

// Botão físico "voltar" do Android: em vez de SAIR do app, volta uma tela
// (fecha popup -> fecha modal -> sai da conversa -> na raiz, minimiza). Sair do
// app fica só para o botão "Sair". Requer o plugin @capacitor/app.
let _androidBackBound = false;
function setupAndroidBackButton() {
  if (_androidBackBound) return;
  const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!App || !App.addListener) return; // só no app nativo
  _androidBackBound = true;
  App.addListener('backButton', () => {
    // 1. Menu/popup aberto -> fecha.
    const pop = document.querySelector('.popup-menu, .emoji-popup, .mention-suggest');
    if (pop) { pop.remove(); return; }
    // 2. Modal aberto -> fecha o mais recente.
    const modals = document.querySelectorAll('.modal-backdrop');
    if (modals.length) { modals[modals.length - 1].remove(); return; }
    // 3. Em chamada -> não faz nada (evita encerrar sem querer).
    if (document.querySelector('.call-overlay:not(.hidden), .gcall-overlay:not(.hidden)')) return;
    // 4. Dentro de uma conversa -> volta para a lista.
    if (state.activeChatId) {
      state.activeChatId = null;
      $('#app').classList.remove('in-chat');
      $('#chat-view').classList.add('hidden');
      $('#empty-state').classList.remove('hidden');
      renderChatList();
      return;
    }
    // 5. Na raiz -> MINIMIZA (nunca sai; sair só pelo botão "Sair").
    try { App.minimizeApp(); } catch { /* ignore */ }
  });
}

// Last known result of the native FCM registration so the Settings screen can
// show — live — whether "chamada com app fechado" is armed on this device.
// Possible status values: 'ok' | 'browser' | 'no-auth' | 'empty-token' | 'error'.
let lastFcmPushStatus = { status: 'unknown', detail: null, at: 0 };

// Store the latest FCM registration result and broadcast it so any open Settings
// panel updates its indicator without polling. Returns the stored object so
// setupNativeCallPush() callers can also read the outcome directly.
function setFcmPushStatus(status, detail = null) {
  lastFcmPushStatus = { status, detail, at: Date.now() };
  try {
    window.dispatchEvent(new CustomEvent('speedvox:fcm-status', { detail: lastFcmPushStatus }));
  } catch {}
  return lastFcmPushStatus;
}

// Native Android (Capacitor): register this device's FCM token so the server
// can ring incoming calls in full screen even with the app closed.
// Returns (and broadcasts) a { status, detail, at } result:
//   ok          – token obtained and registered on the server
//   browser     – no native call plugin (running in a plain browser/PWA)
//   no-auth     – not signed in yet, so there is nothing to attach the token to
//   empty-token – the plugin/Google returned no token (usually transient)
//   error       – an exception was thrown while registering
async function setupNativeCallPush() {
  try {
    const cap = window.Capacitor || null;
    const plugins = cap && cap.Plugins ? cap.Plugins : {};
    const plugin = plugins.SpeedvoxCall;

    const nativeFlag = (() => {
      try { return isNative(); } catch { return false; }
    })();

    console.log('FCM_REGISTER_START', {
      nativeFlag,
      hasCapacitor: Boolean(cap),
      hasPlugins: Boolean(cap && cap.Plugins),
      hasSpeedvoxCall: Boolean(plugin),
      hasGetToken: Boolean(plugin && plugin.getToken),
      hasAuthToken: Boolean(getToken && getToken()),
    });

    // Do not rely only on isNative(); some Capacitor builds report it differently.
    // If the native plugin exists, try it.
    if (!plugin || !plugin.getToken) {
      console.warn('FCM_REGISTER_NO_PLUGIN');
      return setFcmPushStatus('browser');
    }

    if (!getToken || !getToken()) {
      console.warn('FCM_REGISTER_NO_AUTH_TOKEN');
      return setFcmPushStatus('no-auth');
    }

    const result = await plugin.getToken();
    const token = result && result.token;

    console.log('FCM_REGISTER_TOKEN_RESULT', {
      hasToken: Boolean(token),
      tokenLength: token ? String(token).length : 0,
    });

    if (!token) {
      console.warn('FCM_REGISTER_EMPTY_TOKEN');
      return setFcmPushStatus('empty-token');
    }

    await api.registerFcm(token);
    console.log('FCM_REGISTER_OK');
    return setFcmPushStatus('ok', { tokenLength: String(token).length });
  } catch (err) {
    console.error('FCM_REGISTER_ERROR', err && (err.stack || err.message || err));
    return setFcmPushStatus('error', { message: err && (err.message || String(err)) });
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

function initFakePanicVault() {
  state.me = { id: 'panic-me', displayName: 'Jardel Cassimiro', username: 'jardel', avatarUrl: null };
  const mockList = [
    {
      id: 'mock-1',
      type: 'direct',
      title: 'Mãe ❤️',
      unread: 0,
      avatarUrl: null,
      lastMessage: { type: 'text', body: 'Oi filho, tudo bem? Me liga quando puder.', createdAt: Date.now() - 3600 * 1000 }
    },
    {
      id: 'mock-2',
      type: 'direct',
      title: 'Amor 😍',
      unread: 0,
      avatarUrl: null,
      lastMessage: { type: 'text', body: 'Estou comprando as coisas pro jantar!', createdAt: Date.now() - 7200 * 1000 }
    },
    {
      id: 'mock-3',
      type: 'group',
      title: 'Trabalho (Projetos)',
      unread: 0,
      avatarUrl: null,
      lastMessage: { type: 'text', body: 'Marcos: Relatório enviado para o cliente.', createdAt: Date.now() - 10000 * 1000 }
    }
  ];
  state.chats.clear();
  for (const c of mockList) {
    state.chats.set(c.id, c);
    state.messages.set(c.id, [
      { id: `msg-${c.id}-1`, chatId: c.id, senderId: 'other', type: 'text', body: c.lastMessage.body, createdAt: c.lastMessage.createdAt }
    ]);
  }
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderChatList();
}

async function boot() {
  // Bloqueio do app (PIN/digital) — se ativado, pede pra desbloquear antes
  // de mostrar qualquer coisa.
  await applock.guard();

  if (localStorage.getItem('speedvox_panic_active') === '1') {
    initFakePanicVault();
    setupInstallPrompt();
    return;
  }

  setupAuthScreen();
  checkVerifiedParam();

  // Pick up a token handed back by the Google OAuth callback.
  if (location.hash.startsWith('#token=')) {
    setToken(decodeURIComponent(location.hash.slice(7)));
    history.replaceState(null, '', location.pathname);
  }

  window.addEventListener('online', () => {
    hasInternetConnection({ force: true, timeoutMs: 2500 }).catch(() => {});
  });

  window.addEventListener('offline', () => {
    hasInternetConnection({ force: true, timeoutMs: 1500 }).catch(() => {});
  });

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
    const h = await fetchServerHealth();
    setServerReachable(Boolean(h && h.ok));
    updateNetIndicator();
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

  // Open the right chat or answer a call when a notification is tapped.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-chat' && e.data.chatId && state.chats.has(e.data.chatId)) {
        openChat(e.data.chatId);
      }
      if (e.data && e.data.type === 'answer-call' && e.data.callId) {
        state.pendingAnswerCallId = e.data.callId;
        if (state.calls && state.calls.callId === e.data.callId && state.calls.role === 'callee') {
          state.calls._accept();
        }
      }
      if (e.data && e.data.type === 'decline-call' && e.data.callId) {
        if (state.calls && state.calls.callId === e.data.callId && state.calls.role === 'callee') {
          state.calls._reject();
        } else {
          state.pendingDeclineCallId = e.data.callId;
        }
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
  const actionParam = new URLSearchParams(location.search).get('action');
  const callIdParam = new URLSearchParams(location.search).get('callId');
  if (actionParam === 'answer' && callIdParam) {
    history.replaceState(null, '', location.pathname);
    state.pendingAnswerCallId = callIdParam;
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
    // "stale cached version" problem where new features didn't appear on mobile).
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return; // don't reload on the very first install
      reloading = true;
      window.location.reload();
    });

    function activateWaiting(reg) {
      // Tell the waiting SW to skip waiting and activate immediately
      // instead of waiting for all browser tabs to close (critical for mobile PWA).
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }

    navigator.serviceWorker.register('/service-worker.js').then((reg) => {
      activateWaiting(reg); // in case SW was already waiting at load
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (incoming) {
          incoming.addEventListener('statechange', () => {
            if (incoming.state === 'installed') activateWaiting(reg);
          });
        }
      });
      // Poll: on focus, on visibility restore (mobile minimise→return), and once at start.
      reg.update().catch(() => {});
      window.addEventListener('focus', () => reg.update().catch(() => {}));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  }
}

async function showTasksModal() {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;

  const content = el('div', { class: 'modal-body', style: 'max-height: 480px; overflow-y: auto;' });
  const footer = el('div', { class: 'modal-footer', style: 'display:flex; gap:8px;' });

  const renderTaskList = async () => {
    content.innerHTML = '';
    try {
      const { tasks } = await api.listTasks(chat.id);
      if (tasks.length === 0) {
        content.append(el('p', { style: 'text-align:center; color:var(--text-2); padding:20px;' }, 'Nenhuma tarefa criada para este chat ainda.'));
      } else {
        const list = el('div', { style: 'display:flex; flex-direction:column; gap:10px;' });
        for (const t of tasks) {
          const assignee = chat.members ? chat.members.find((m) => m.id === t.assignee_id) : null;
          const assigneeName = assignee ? assignee.displayName : 'Não atribuído';
          
          const checkbox = el('input', { type: 'checkbox', checked: t.completed ? '' : null, style: 'cursor:pointer; width:18px; height:18px;' });
          checkbox.onchange = async () => {
            await api.updateTask(chat.id, t.id, { completed: checkbox.checked });
            toast(checkbox.checked ? 'Tarefa concluída! 🎉' : 'Tarefa reaberta');
            renderTaskList();
          };

          const taskTitle = el('span', {
            style: `font-size:15px; font-weight:500; cursor:pointer; flex:1; ${t.completed ? 'text-decoration:line-through; color:var(--text-2);' : ''}`
          }, t.title);
          
          taskTitle.onclick = () => {
            checkbox.checked = !checkbox.checked;
            checkbox.dispatchEvent(new Event('change'));
          };

          const metaInfo = el('div', { style: 'font-size:12px; color:var(--text-2); margin-top:2px;' },
            `Responsável: ${assigneeName}` + (t.due_date ? ` · Prazo: ${new Date(t.due_date).toLocaleDateString()}` : '')
          );

          const taskRow = el('div', {
            style: 'display:flex; align-items:flex-start; gap:12px; padding:10px; border-radius:8px; background:var(--panel-3); border-left:4px solid ' + (t.completed ? 'var(--success)' : 'var(--accent)')
          },
            checkbox,
            el('div', { style: 'flex:1; display:flex; flex-direction:column;' }, taskTitle, metaInfo)
          );
          list.append(taskRow);
        }
        content.append(list);
      }
    } catch (err) {
      content.append(el('p', { class: 'auth-error' }, 'Erro ao carregar tarefas: ' + err.message));
    }
  };

  const addBtn = el('button', { class: 'btn-primary', style: 'flex:1; margin:0;' }, '＋ Nova Tarefa');
  addBtn.onclick = () => {
    const titleInput = el('input', { class: 'select-input', type: 'text', placeholder: 'Título da tarefa', style: 'margin-bottom:10px' });
    const assigneeSelect = el('select', { class: 'select-input', style: 'margin-bottom:10px' },
      el('option', { value: '' }, 'Sem responsável'));
    if (chat.members) {
      for (const m of chat.members) {
        assigneeSelect.append(el('option', { value: m.id }, m.displayName));
      }
    }
    const dueDateInput = el('input', { class: 'select-input', type: 'date', style: 'margin-bottom:10px' });
    const err = el('div', { class: 'auth-error' });
    const save = el('button', { class: 'btn-primary', style: 'width:100%' }, 'Adicionar');

    const body = el('div', { class: 'modal-body' }, titleInput, assigneeSelect, dueDateInput, err, save);
    const addBd = modalShell('Nova Tarefa', body);

    save.onclick = async () => {
      const title = titleInput.value.trim();
      if (!title) { err.textContent = 'O título é obrigatório.'; return; }
      try {
        await api.createTask(chat.id, {
          title,
          assigneeId: assigneeSelect.value || null,
          dueDate: dueDateInput.value ? new Date(dueDateInput.value).getTime() : null
        });
        addBd.remove();
        renderTaskList();
      } catch (e) {
        err.textContent = e.message;
      }
    };
  };

  footer.append(addBtn);
  const bd = modalShell('📋 Tarefas Coletivas', content, footer);
  await renderTaskList();
}

function createTaskFromMessage(m) {
  const chat = state.chats.get(state.activeChatId);
  if (!chat) return;

  const titleInput = el('input', { class: 'select-input', type: 'text', value: m._plain || m.body || '', placeholder: 'Título da tarefa', style: 'margin-bottom:10px' });
  
  const assigneeSelect = el('select', { class: 'select-input', style: 'margin-bottom:10px' },
    el('option', { value: '' }, 'Sem responsável (Não atribuído)'));
  if (chat.members) {
    for (const member of chat.members) {
      assigneeSelect.append(el('option', { value: member.id }, member.displayName));
    }
  }

  const dueDateInput = el('input', { class: 'select-input', type: 'date', style: 'margin-bottom:10px' });

  const err = el('div', { class: 'auth-error' });
  const save = el('button', { class: 'btn-primary', style: 'width:100%' }, '📋 Criar Tarefa');

  const body = el('div', { class: 'modal-body' },
    el('p', { class: 'auth-hint', style: 'margin-top:0' }, 'Transforme esta mensagem em uma tarefa colaborativa para o grupo.'),
    el('label', { style: 'font-weight:bold;font-size:12px;display:block;margin-bottom:4px;' }, 'Título'),
    titleInput,
    el('label', { style: 'font-weight:bold;font-size:12px;display:block;margin-bottom:4px;' }, 'Responsável'),
    assigneeSelect,
    el('label', { style: 'font-weight:bold;font-size:12px;display:block;margin-bottom:4px;' }, 'Prazo de entrega'),
    dueDateInput,
    err, save);
  const bd = modalShell('📋 Criar Tarefa', body);

  save.onclick = async () => {
    const title = titleInput.value.trim();
    if (!title) { err.textContent = 'O título é obrigatório.'; return; }
    
    try {
      const dueDateVal = dueDateInput.value ? new Date(dueDateInput.value).getTime() : null;
      await api.createTask(chat.id, {
        title,
        messageId: m.id,
        assigneeId: assigneeSelect.value || null,
        dueDate: dueDateVal
      });
      bd.remove();
      toast('Tarefa criada! ✅');
    } catch (e) {
      err.textContent = e.message || 'Falha ao criar tarefa';
    }
  };
}

async function renderStatusList() {
  renderFolderTabs();
  const list = $('#chat-list');
  list.innerHTML = '';
  
  list.append(el('li', { style: 'text-align:center; padding:20px; color:var(--text-dim)' }, 'Carregando status...'));

  try {
    const feed = await api.statusFeed();
    list.innerHTML = '';
    
    // 1. My status item
    const myAvatar = el('span', { class: 'avatar' });
    avatarBg(myAvatar, state.me.avatarUrl, state.me.displayName);
    
    const myItem = el('li', { class: 'chat-item' },
      el('span', { class: `status-ring${feed.me.length ? ' seen' : ''}` }, myAvatar),
      el('div', { class: 'chat-item-body' },
        el('div', { class: 'chat-item-head' },
          el('span', { class: 'chat-item-title' }, 'Meu Status'),
          el('span', { class: 'chat-item-time' }, '')),
        el('div', { class: 'chat-item-preview' },
          feed.me.length ? `${feed.me.length} atualização(ões) · Toque para ver` : 'Clique para adicionar um status')),
      el('button', {
        class: 'icon-btn',
        title: 'Adicionar status',
        style: 'margin-left: 10px; font-size: 20px; background: none; border: none; cursor: pointer; color: var(--accent);',
        onclick: (e) => { e.stopPropagation(); statusComposer(); }
      }, '＋')
    );
    
    myItem.onclick = () => {
      if (feed.me.length) viewStatuses(feed.me, state.me, true);
      else statusComposer();
    };
    list.append(myItem);
    
    // Divider
    if (feed.contacts.length > 0) {
      list.append(el('li', { class: 'day-divider', style: 'padding: 8px 12px; font-size: 12px; background: var(--panel-3); color: var(--text-dim);' }, 'Atualizações recentes'));
    }

    // 2. Contacts' status items
    for (const g of feed.contacts) {
      const contactAvatar = el('span', { class: 'avatar' });
      avatarBg(contactAvatar, g.user.avatarUrl, g.user.displayName);
      
      const item = el('li', { class: 'chat-item' },
        el('span', { class: `status-ring${g.hasUnviewed ? '' : ' seen'}` }, contactAvatar),
        el('div', { class: 'chat-item-body' },
          el('div', { class: 'chat-item-head' },
            el('span', { class: 'chat-item-title' }, g.user.displayName),
            el('span', { class: 'chat-item-time' }, fmtTime(g.latestAt))),
          el('div', { class: 'chat-item-preview' }, `${g.statuses.length} atualização(ões)`))
      );
      
      item.onclick = () => {
        viewStatuses(g.statuses, g.user, false);
      };
      list.append(item);
    }
    
    if (feed.contacts.length === 0) {
      list.append(el('li', { style: 'text-align:center; padding:30px; color:var(--text-dim); font-size: 14px;' }, 'Nenhum status recente dos seus contatos.'));
    }
  } catch (e) {
    list.innerHTML = '';
    list.append(el('li', { style: 'text-align:center; padding:20px; color:var(--danger)' }, 'Falha ao carregar status: ' + e.message));
  }
}

boot();
