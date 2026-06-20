'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { publicUser, now } = require('../util');

const router = express.Router();
router.use(requireAuth);

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
  const { displayName, about, avatarUrl } = req.body || {};
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
  if (!fields.length) return res.status(400).json({ error: 'nada para atualizar' });
  values.push(req.user.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(u) });
});

module.exports = router;
