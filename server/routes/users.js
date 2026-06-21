'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { publicUser, now } = require('../util');
const bus = require('../bus');

const router = express.Router();
router.use(requireAuth);

// Find an existing direct chat between two users (without creating one).
function directChatId(a, b) {
  const row = db
    .prepare(
      `SELECT c.id FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
       WHERE c.type = 'direct' LIMIT 1`
    )
    .get(a, b);
  return row ? row.id : null;
}

// List the users I have blocked.
router.get('/me/blocks', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = ? ORDER BY b.created_at DESC`
    )
    .all(req.user.id);
  res.json({ users: rows.map(publicUser) });
});

// Block a user.
router.post('/:id/block', (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'não é possível bloquear a si mesmo' });
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(req.params.id)) {
    return res.status(404).json({ error: 'usuário não encontrado' });
  }
  db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, req.params.id, now());
  const cid = directChatId(req.user.id, req.params.id);
  if (cid) bus.pushChatUpdate(cid);
  res.json({ ok: true });
});

// Unblock a user.
router.post('/:id/unblock', (req, res) => {
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, req.params.id);
  const cid = directChatId(req.user.id, req.params.id);
  if (cid) bus.pushChatUpdate(cid);
  res.json({ ok: true });
});

// Search users by username, display name or email — contacts without phone numbers.
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ users: [] });
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT * FROM users
       WHERE id != ?
         AND (lower(username) LIKE ? OR lower(display_name) LIKE ? OR lower(email) = ?)
       ORDER BY display_name LIMIT 20`
    )
    .all(req.user.id, like, like, q);
  res.json({ users: rows.map(publicUser) });
});

// Get a single user's public profile.
router.get('/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({ user: publicUser(u) });
});

// Update own profile.
router.patch('/me', (req, res) => {
  const { displayName, about, avatarUrl, publicKey } = req.body || {};
  const fields = [];
  const values = [];
  if (typeof displayName === 'string' && displayName.trim()) {
    fields.push('display_name = ?');
    values.push(displayName.trim());
  }
  if (typeof about === 'string') {
    fields.push('about = ?');
    values.push(about.slice(0, 140));
  }
  if (typeof avatarUrl === 'string') {
    fields.push('avatar_url = ?');
    values.push(avatarUrl);
  }
  if (typeof publicKey === 'string' && publicKey.length < 2000) {
    fields.push('public_key = ?');
    values.push(publicKey);
  }
  if (!fields.length) return res.status(400).json({ error: 'nada para atualizar' });
  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(u) });
});

module.exports = router;
