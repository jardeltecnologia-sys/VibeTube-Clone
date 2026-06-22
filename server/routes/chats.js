'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth-middleware');
const { id, now } = require('../util');

// Current member count of a group (used to enforce the size cap).
function memberCount(chatId) {
  return db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(chatId).n;
}
const {
  isMember, getChatSummary, listChatsForUser, findOrCreateDirectChat, findOrCreateSavedChat,
  serializeMessage, getMemberIds, canAddToGroup,
} = require('../chat-service');
const bus = require('../bus');

const router = express.Router();
router.use(requireAuth);

// Helper: load a group and the caller's membership, enforcing admin if required.
function loadGroup(req, res, { requireAdmin } = {}) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat || chat.type !== 'group') { res.status(404).json({ error: 'grupo não encontrado' }); return null; }
  const me = db
    .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!me) { res.status(403).json({ error: 'forbidden' }); return null; }
  if (requireAdmin && me.role !== 'admin') { res.status(403).json({ error: 'apenas admins' }); return null; }
  return { chat, me };
}

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
  if (members.length + 1 > config.groupMaxMembers) {
    return res.status(400).json({ error: `Um grupo pode ter no máximo ${config.groupMaxMembers} participantes` });
  }

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
      if (m !== req.user.id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(m)
          && canAddToGroup(m, req.user.id)) {
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

// Open (or create) my personal "Saved Messages" chat.
router.post('/saved', (req, res) => {
  const chatId = findOrCreateSavedChat(req.user.id);
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
      `SELECT m.* FROM messages m WHERE m.chat_id = ? AND m.created_at < ?
         AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND (m.send_at IS NULL OR m.send_at <= ?)
         AND NOT EXISTS (SELECT 1 FROM blocks b
           WHERE b.blocker_id = ? AND b.blocked_id = m.sender_id AND m.created_at >= b.created_at)
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(req.params.id, before, now(), now(), req.user.id, limit);
  // Annotate which messages this user has starred.
  const starredIds = new Set(
    db.prepare('SELECT message_id FROM starred WHERE user_id = ?').all(req.user.id).map((r) => r.message_id)
  );
  res.json({ messages: rows.reverse().map((m) => ({ ...serializeMessage(m), starred: starredIds.has(m.id) })) });
});

// Set the disappearing-messages timer for a chat (any participant). 0 = off.
router.post('/:id/disappearing', (req, res) => {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  let seconds = parseInt(req.body && req.body.seconds, 10);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.min(seconds, 365 * 24 * 3600); // cap at 1 year
  db.prepare('UPDATE chats SET disappearing_timer = ? WHERE id = ?').run(seconds, req.params.id);
  const label = seconds === 0 ? 'desativou as mensagens temporárias'
    : `ativou mensagens temporárias (${humanizeDuration(seconds)})`;
  bus.systemMessage(req.params.id, `${req.user.display_name} ${label}`, req.user.id);
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

function humanizeDuration(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400} dia(s)`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hora(s)`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}

// Rename a group or change its photo (admins only).
router.patch('/:id', (req, res) => {
  const ctx = loadGroup(req, res, { requireAdmin: true });
  if (!ctx) return;
  const { name, avatarUrl } = req.body || {};
  let renamed = false;
  if (typeof name === 'string' && name.trim() && name.trim() !== ctx.chat.name) {
    db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    renamed = true;
  }
  if (typeof avatarUrl === 'string') {
    db.prepare('UPDATE chats SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.params.id);
  }
  if (renamed) {
    bus.systemMessage(req.params.id, `${req.user.display_name} alterou o nome do grupo para "${name.trim()}"`, req.user.id);
  } else {
    bus.pushChatUpdate(req.params.id);
  }
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

// Add members to a group (admins only).
router.post('/:id/members', (req, res) => {
  const ctx = loadGroup(req, res, { requireAdmin: true });
  if (!ctx) return;
  const { memberIds } = req.body || {};
  const ins = db.prepare(
    'INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
  );
  const added = [];
  const blockedByPrivacy = [];
  let count = memberCount(req.params.id);
  for (const m of memberIds || []) {
    if (count >= config.groupMaxMembers) break; // respect the size cap
    const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(m);
    if (!u || isMember(req.params.id, m)) continue;
    if (!canAddToGroup(m, req.user.id)) { blockedByPrivacy.push(u.display_name); continue; }
    ins.run(req.params.id, m, 'member', now());
    added.push(u.display_name);
    count += 1;
  }
  if (added.length) {
    bus.systemMessage(req.params.id, `${req.user.display_name} adicionou ${added.join(', ')}`, req.user.id);
  }
  res.json({ chat: getChatSummary(req.params.id, req.user.id), blockedByPrivacy });
});

// Remove a member from a group (admins only).
router.delete('/:id/members/:userId', (req, res) => {
  const ctx = loadGroup(req, res, { requireAdmin: true });
  if (!ctx) return;
  const target = req.params.userId;
  if (target === req.user.id) return res.status(400).json({ error: 'use sair do grupo' });
  const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(target);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.params.id, target);
  if (u) bus.systemMessage(req.params.id, `${req.user.display_name} removeu ${u.display_name}`, req.user.id);
  bus.pushChatRemoved(req.params.id, target);
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

// Promote/demote a member (admins only).
router.post('/:id/members/:userId/role', (req, res) => {
  const ctx = loadGroup(req, res, { requireAdmin: true });
  if (!ctx) return;
  const { role } = req.body || {};
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'papel inválido' });
  if (!isMember(req.params.id, req.params.userId)) return res.status(404).json({ error: 'não é membro' });
  db.prepare('UPDATE chat_members SET role = ? WHERE chat_id = ? AND user_id = ?')
    .run(role, req.params.id, req.params.userId);
  const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.params.userId);
  if (u) {
    bus.systemMessage(req.params.id,
      role === 'admin' ? `${u.display_name} agora é admin` : `${u.display_name} não é mais admin`,
      req.user.id);
  }
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

// Per-user chat organization: pin, archive, mute. Affects only the caller.
function setMembershipFlag(req, res, column, value) {
  if (!isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  db.prepare(`UPDATE chat_members SET ${column} = ? WHERE chat_id = ? AND user_id = ?`)
    .run(value, req.params.id, req.user.id);
  // Sync the change across the caller's other devices.
  bus.pushChatUpdate(req.params.id);
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
}

// Pin (or unpin) a message in a chat. Groups: admins only. Direct: any member.
router.post('/:id/pin-message', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat || !isMember(req.params.id, req.user.id)) return res.status(403).json({ error: 'forbidden' });
  if (chat.type === 'group') {
    const me = db.prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'apenas admins' });
  }
  const { messageId } = req.body || {};
  if (messageId) {
    const m = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(messageId, req.params.id);
    if (!m) return res.status(404).json({ error: 'mensagem não encontrada' });
    db.prepare('UPDATE chats SET pinned_message_id = ? WHERE id = ?').run(messageId, req.params.id);
    bus.systemMessage(req.params.id, `${req.user.display_name} fixou uma mensagem`, req.user.id);
  } else {
    db.prepare('UPDATE chats SET pinned_message_id = NULL WHERE id = ?').run(req.params.id);
    bus.pushChatUpdate(req.params.id);
  }
  res.json({ chat: getChatSummary(req.params.id, req.user.id) });
});

router.post('/:id/pin', (req, res) => setMembershipFlag(req, res, 'pinned', req.body && req.body.pinned ? 1 : 0));
router.post('/:id/archive', (req, res) => setMembershipFlag(req, res, 'archived', req.body && req.body.archived ? 1 : 0));
router.post('/:id/mute', (req, res) => {
  const until = req.body && Number(req.body.until) ? Number(req.body.until) : 0;
  return setMembershipFlag(req, res, 'muted_until', until);
});

// Leave a chat. If the last admin of a group leaves, promote the oldest member.
router.post('/:id/leave', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  const wasAdmin = db
    .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.params.id, req.user.id);

  if (chat && chat.type === 'group') {
    bus.systemMessage(req.params.id, `${req.user.display_name} saiu do grupo`, req.user.id);
    const remaining = getMemberIds(req.params.id);
    const stillAdmin = db
      .prepare("SELECT 1 FROM chat_members WHERE chat_id = ? AND role = 'admin' LIMIT 1")
      .get(req.params.id);
    if (remaining.length && !stillAdmin) {
      const oldest = db
        .prepare('SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at LIMIT 1')
        .get(req.params.id);
      if (oldest) {
        db.prepare("UPDATE chat_members SET role = 'admin' WHERE chat_id = ? AND user_id = ?")
          .run(req.params.id, oldest.user_id);
        bus.pushChatUpdate(req.params.id);
      }
    }
  }
  bus.pushChatRemoved(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
