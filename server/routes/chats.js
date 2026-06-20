'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { id, now } = require('../util');
const {
  isMember, getChatSummary, listChatsForUser, findOrCreateDirectChat, serializeMessage,
} = require('../chat-service');

const router = express.Router();
router.use(requireAuth);

// List all chats for the current user.
router.get('/', (req, res) => {
  res.json({ chats: listChatsForUser(req.user.id) });
});

// Open (or create) a 1:1 chat with another user.
router.post('/direct', (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId obrigatório' });
  if (userId === req.user.id) return res.status(400).json({ error: 'não é possível conversar consigo mesmo' });
  const other = db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId);
  if (!other) return res.status(404).json({ error: 'usuário não encontrado' });

  const chatId = findOrCreateDirectChat(req.user.id, userId);
  res.json({ chat: getChatSummary(chatId, req.user.id) });
});

// Create a group chat.
router.post('/group', (req, res) => {
  const { name, memberIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Informe o nome do grupo' });
  const members = Array.isArray(memberIds) ? [...new Set(memberIds)] : [];

  const chatId = id();
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare(
      'INSERT INTO chats (id, type, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(chatId, 'group', name.trim(), req.user.id, ts);
    db.prepare(
      'INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(chatId, req.user.id, 'admin', ts);
    const ins = db.prepare(
      'INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    );
    for (const m of members) {
      if (m !== req.user.id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(m)) {
        ins.run(chatId, m, 'member', ts);
      }
    }
    // System message announcing creation.
    db.prepare(
      `INSERT INTO messages (id, chat_id, sender_id, type, body, created_at)
       VALUES (?, ?, ?, 'system', ?, ?)`
    ).run(id(), chatId, req.user.id, `${req.user.display_name} criou o grupo "${name.trim()}"`, ts);
  });
  tx();

  res.json({ chat: getChatSummary(chatId, req.user.id) });
});

// Get a single chat summary.
router.get('/:id', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

// Get message history for a chat (paginated by `before` timestamp).
router.get('/:id/messages', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  const before = parseInt(req.query.before, 10) || now() + 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND created_at < ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(req.params.id, before, limit);
  res.json({ messages: rows.reverse().map(serializeMessage) });
});

// Add members to a group (admins only).
router.post('/:id/members', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat || chat.type !== 'group') return res.status(404).json({ error: 'grupo não encontrado' });
  const me = db
    .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!me || me.role !== 'admin') return res.status(403).json({ error: 'apenas admins' });

  const { memberIds } = req.body || {};
  const ins = db.prepare(
    'INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  );
  for (const m of memberIds || []) {
    if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(m)) ins.run(req.params.id, m, 'member', now());
  }
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

// Leave a chat.
router.post('/:id/leave', (req, res) => {
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(
    req.params.id,
    req.user.id
  );
  res.json({ ok: true });
});

module.exports = router;
