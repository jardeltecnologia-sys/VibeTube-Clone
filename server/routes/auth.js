'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth-middleware');
const {
  id, now, signToken, publicUser, isValidEmail, isValidUsername,
} = require('../util');

const router = express.Router();

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
  db.prepare(
    `INSERT INTO users (id, username, email, password, display_name, about, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, username, email.toLowerCase(), hash, displayName.trim(), 'Disponível', now());

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
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

  res.json({ token: signToken(user), user: publicUser(user) });
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
