'use strict';

// Push nativo via FCM HTTP v1 — toca a chamada em tela cheia no Android mesmo
// com o app fechado. Sem dependências externas: assina o JWT do service account
// com `crypto` e troca por um access token. Fica desativado (no-op) enquanto
// FCM_SERVICE_ACCOUNT[_JSON] não estiver configurado no .env.

const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const { now } = require('./util');

db.exec(`
CREATE TABLE IF NOT EXISTS fcm_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fcm_user ON fcm_tokens(user_id);
`);

function loadServiceAccount() {
  try {
    if (process.env.FCM_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
    const p = process.env.FCM_SERVICE_ACCOUNT;
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('FCM service account inválido:', e.message); }
  return null;
}
const svc = loadServiceAccount();

function isEnabled() {
  return Boolean(svc && svc.private_key && svc.client_email && svc.project_id);
}

function saveToken(userId, token) {
  if (!token) return;
  db.prepare(
    `INSERT INTO fcm_tokens (token, user_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id`
  ).run(token, userId, now());
}
function tokensFor(userId) {
  return db.prepare('SELECT token FROM fcm_tokens WHERE user_id = ?').all(userId).map((r) => r.token);
}
function removeToken(token) {
  db.prepare('DELETE FROM fcm_tokens WHERE token = ?').run(token);
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

let cachedToken = null;
let cachedExp = 0;
async function accessToken() {
  if (cachedToken && Date.now() < cachedExp - 60000) return cachedToken;
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: svc.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const jwt = `${unsigned}.${b64url(sign.sign(svc.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('FCM auth: ' + JSON.stringify(j));
  cachedToken = j.access_token;
  cachedExp = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

// High-priority data message that triggers the native full-screen call UI.
async function sendCall(userId, { caller, callId, media }) {
  if (!isEnabled()) return 0;
  const tokens = tokensFor(userId);
  if (!tokens.length) return 0;
  let at;
  try { at = await accessToken(); } catch (e) { console.error('FCM auth falhou:', e.message); return 0; }
  let sent = 0;
  for (const token of tokens) {
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${svc.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            data: {
              type: 'call',
              caller: String(caller || 'Chamada'),
              callId: String(callId || ''),
              media: String(media || 'audio'),
            },
            android: { priority: 'high' },
          },
        }),
      });
      if (res.ok) { sent += 1; continue; }
      const err = await res.json().catch(() => ({}));
      const status = err && err.error && err.error.status;
      if (status === 'NOT_FOUND' || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT') removeToken(token);
    } catch (e) { /* best-effort */ }
  }
  return sent;
}

module.exports = { isEnabled, saveToken, tokensFor, removeToken, sendCall };
