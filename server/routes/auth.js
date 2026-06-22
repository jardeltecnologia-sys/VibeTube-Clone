'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth-middleware');
const mailer = require('../email');
const rateLimit = require('../rate-limit');
const {
  id, now, signToken, publicUser, isValidEmail, isValidUsername,
} = require('../util');

const router = express.Router();
const DAY = 24 * 60 * 60 * 1000;

// Local/loopback addresses (dev, tests, server-local calls) skip the per-IP cap.
function isLoopback(ip) {
  const a = String(ip || '');
  return a === '::1' || a === '127.0.0.1' || a === '::ffff:127.0.0.1' || a.startsWith('127.');
}

// Create a verification token for a user, persist it, and send the e-mail.
// Returns the token (the caller only exposes it in test mode).
async function createVerification(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const ts = now();
  db.prepare(
    'INSERT INTO email_verification_tokens (token, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, user.id, user.email, ts, ts + DAY);
  const link = `${config.publicUrl}/api/auth/verify-email?token=${token}`;
  try { await mailer.sendVerification(user.email, user.display_name, link); }
  catch (err) { console.error('Falha ao enviar e-mail de verificação:', err.message); }
  return token;
}

// A small HTML page for the verification result (opened from the e-mail link).
function resultPage(ok, message) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SpeedVox</title></head>
    <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0b141a;color:#e9edef;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;text-align:center">
      <div style="padding:24px;max-width:360px">
        <h1 style="color:${ok ? '#00a884' : '#f15c6d'};font-size:26px;margin:0 0 8px">${ok ? '✓ E-mail confirmado!' : 'Link inválido'}</h1>
        <p style="color:#8696a0;line-height:1.5">${message}</p>
        <p style="margin-top:20px"><a href="${ok ? '/?verified=1' : '/'}" style="background:#00a884;color:#04130e;text-decoration:none;
          font-weight:700;padding:12px 24px;border-radius:10px;display:inline-block">Abrir o SpeedVox</a></p>
      </div></body></html>`;
}

function suggestUsername(base) {
  let root = String(base || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, 18) || 'user';
  if (root.length < 3) root = root + 'user';
  let candidate = root;
  let n = 0;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) {
    n += 1;
    candidate = `${root}${n}`;
  }
  return candidate;
}

// --- Email + password registration (no phone number required) ---
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  let { username } = req.body || {};

  // Anti-abuse: limit sign-up attempts per IP (loopback is exempt — real
  // clients always come through the proxy with a forwarded address).
  if (!isLoopback(req.ip)) {
    const rl = rateLimit.check(`register:${req.ip}`, config.registerMaxPerIp, 15 * 60 * 1000);
    if (!rl.allowed) return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${rl.retryAfter}s.` });
  }

  if (!isValidEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres' });
  }
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'Informe um nome de exibição' });
  }

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) {
    return res.status(409).json({ error: 'Este e-mail já está cadastrado' });
  }

  username = (username || '').toLowerCase().trim();
  if (username) {
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Usuário inválido (3-24 letras, números, _ ou .)' });
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return res.status(409).json({ error: 'Este nome de usuário já existe' });
    }
  } else {
    username = suggestUsername(email.split('@')[0]);
  }

  const hash = await bcrypt.hash(password, 10);
  const userId = id();
  const verified = mailer.isEnabled() ? 0 : 1; // pending if verification is on
  db.prepare(
    `INSERT INTO users (id, username, email, password, display_name, about, email_verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, username, req.body.email.toLowerCase(), hash, displayName.trim(), 'Disponível', verified, now());

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  if (mailer.isEnabled()) {
    const token = await createVerification(user);
    const out = { pending: true, email: user.email,
      message: 'Enviamos um e-mail de confirmação. Clique no link para ativar a sua conta.' };
    if (config.emailTestMode) out.devVerifyToken = token; // exposed only in tests
    return res.json(out);
  }
  // Verification disabled: activate immediately (legacy behavior).
  res.json({ token: signToken(user), user: publicUser(user) });
});

// --- Email + password login ---
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
  if (!user || !user.password) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

  if (mailer.isEnabled() && !user.email_verified) {
    return res.status(403).json({ error: 'Confirme o seu e-mail antes de entrar.', needsVerification: true, email: user.email });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
});

// --- Confirm e-mail (opened from the link in the e-mail) ---
router.get('/verify-email', (req, res) => {
  const token = String(req.query.token || '');
  const row = token && db.prepare('SELECT * FROM email_verification_tokens WHERE token = ?').get(token);
  if (!row) return res.status(400).send(resultPage(false, 'Este link de confirmação é inválido.'));
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
    return res.status(400).send(resultPage(false, 'Este link expirou. Faça login e peça um novo e-mail de confirmação.'));
  }
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(row.user_id);
  res.send(resultPage(true, 'Sua conta está ativada. Já pode entrar no SpeedVox.'));
});

// --- Resend the confirmation e-mail ---
router.post('/resend-verification', async (req, res) => {
  const addr = String((req.body && req.body.email) || '').toLowerCase().trim();
  if (!isValidEmail(addr)) return res.status(400).json({ error: 'E-mail inválido' });
  const rl = rateLimit.check(`resend:${addr}`, 3, 60 * 60 * 1000);
  if (!rl.allowed) return res.status(429).json({ error: `Aguarde ${rl.retryAfter}s para reenviar.` });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(addr);
  // Always respond the same way (don't reveal whether the e-mail exists).
  if (user && !user.email_verified && mailer.isEnabled()) {
    const token = await createVerification(user);
    if (config.emailTestMode) return res.json({ ok: true, devVerifyToken: token });
  }
  res.json({ ok: true });
});

// --- Current session ---
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), google: { enabled: config.google.enabled } });
});

// --- Google OAuth: start ---
router.get('/google', (req, res) => {
  if (!config.google.enabled) {
    return res.status(503).send('Login com Google não está configurado neste servidor.');
  }
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: config.google.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// --- Google OAuth: callback ---
router.get('/google/callback', async (req, res) => {
  if (!config.google.enabled) return res.status(503).send('Google não configurado.');
  const { code } = req.query;
  if (!code) return res.status(400).send('Código de autorização ausente.');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('Falha ao obter token do Google');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.id) throw new Error('Falha ao obter perfil do Google');

    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
    if (!user && profile.email) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email.toLowerCase());
      if (user) {
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(profile.id, user.id);
      }
    }
    if (!user) {
      const userId = id();
      const username = suggestUsername(
        (profile.email && profile.email.split('@')[0]) || profile.name
      );
      db.prepare(
        `INSERT INTO users (id, username, email, google_id, display_name, avatar_url, about, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        username,
        profile.email ? profile.email.toLowerCase() : null,
        profile.id,
        profile.name || username,
        profile.picture || null,
        'Disponível',
        now()
      );
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    }

    const token = signToken(user);
    // Hand the token to the SPA via the URL fragment, then let it store the session.
    res.redirect(`/auth-callback.html#token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.status(500).send('Erro ao autenticar com o Google.');
  }
});

module.exports = router;
