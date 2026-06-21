'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { now } = require('../util');
const { isMember, serializeMessage } = require('../chat-service');

const router = express.Router();
router.use(requireAuth);

// List my starred messages (most recent first), with their chat id.
router.get('/starred', (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.* FROM starred s JOIN messages m ON m.id = s.message_id
       WHERE s.user_id = ? AND m.deleted = 0
       ORDER BY s.created_at DESC LIMIT 200`
    )
    .all(req.user.id);
  res.json({ messages: rows.map((m) => ({ ...serializeMessage(m), starred: true })) });
});

// Star / unstar a message.
router.post('/:id/star', (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg || !isMember(msg.chat_id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  const starred = !(req.body && req.body.starred === false);
  if (starred) {
    db.prepare('INSERT OR IGNORE INTO starred (user_id, message_id, created_at) VALUES (?, ?, ?)')
      .run(req.user.id, req.params.id, now());
  } else {
    db.prepare('DELETE FROM starred WHERE user_id = ? AND message_id = ?').run(req.user.id, req.params.id);
  }
  res.json({ ok: true, starred });
});

module.exports = router;
