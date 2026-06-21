'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');

const router = express.Router();
router.use(requireAuth);

// Search messages across the caller's chats. Only plaintext is searchable on the
// server — end-to-end encrypted bodies are opaque here and are searched on the
// client over locally-decrypted messages.
router.get('/messages', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q}%`;
  const params = [req.user.id, like, like];
  let chatFilter = '';
  if (req.query.chatId) { chatFilter = 'AND m.chat_id = ?'; params.push(String(req.query.chatId)); }

  const rows = db
    .prepare(
      `SELECT m.id, m.chat_id, m.sender_id, m.type, m.body, m.media_name, m.created_at
       FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.deleted = 0 AND m.encrypted = 0 AND m.type != 'system'
         AND (lower(m.body) LIKE ? OR lower(m.media_name) LIKE ?)
         ${chatFilter}
       ORDER BY m.created_at DESC
       LIMIT 40`
    )
    .all(...params);

  res.json({
    results: rows.map((r) => ({
      messageId: r.id,
      chatId: r.chat_id,
      senderId: r.sender_id,
      type: r.type,
      body: r.body,
      mediaName: r.media_name,
      createdAt: r.created_at,
    })),
  });
});

module.exports = router;
