'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { id, now, publicUser } = require('../util');
const { contactsOf, iBlocked, isBlockedEither } = require('../chat-service');
const bus = require('../bus');

const DAY = 24 * 60 * 60 * 1000;
const router = express.Router();
router.use(requireAuth);

function serializeStatus(s) {
  return {
    id: s.id,
    userId: s.user_id,
    type: s.type,
    body: s.body,
    mediaUrl: s.media_url,
    bgColor: s.bg_color,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
  };
}

const activeStatuses = (userId) =>
  db.prepare('SELECT * FROM statuses WHERE user_id = ? AND expires_at > ? ORDER BY created_at')
    .all(userId, now());

// Post a new status (expires in 24h).
router.post('/', (req, res) => {
  const { type, body, mediaUrl, bgColor } = req.body || {};
  const kind = type === 'image' ? 'image' : 'text';
  if (kind === 'text' && (!body || !body.trim())) return res.status(400).json({ error: 'texto vazio' });
  if (kind === 'image' && !mediaUrl) return res.status(400).json({ error: 'imagem ausente' });
  const ts = now();
  const sid = id();
  db.prepare(
    `INSERT INTO statuses (id, user_id, type, body, media_url, bg_color, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(sid, req.user.id, kind, body ? body.slice(0, 700) : null, mediaUrl || null,
        bgColor || null, ts, ts + DAY);
  bus.pushStatusUpdate(req.user.id);
  res.json({ status: serializeStatus(db.prepare('SELECT * FROM statuses WHERE id = ?').get(sid)) });
});

// Status feed: my own statuses (with view counts) + contacts' statuses grouped.
router.get('/', (req, res) => {
  const me = activeStatuses(req.user.id).map((s) => ({
    ...serializeStatus(s),
    viewCount: db.prepare('SELECT COUNT(*) AS c FROM status_views WHERE status_id = ?').get(s.id).c,
  }));

  const groups = [];
  for (const contactId of contactsOf(req.user.id)) {
    const rows = activeStatuses(contactId);
    if (!rows.length) continue;
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(contactId));
    const statuses = rows.map((s) => ({
      ...serializeStatus(s),
      viewed: Boolean(
        db.prepare('SELECT 1 FROM status_views WHERE status_id = ? AND viewer_id = ?')
          .get(s.id, req.user.id)
      ),
    }));
    groups.push({
      user,
      statuses,
      hasUnviewed: statuses.some((s) => !s.viewed),
      latestAt: rows[rows.length - 1].created_at,
    });
  }
  groups.sort((a, b) => (a.hasUnviewed !== b.hasUnviewed ? (a.hasUnviewed ? -1 : 1) : b.latestAt - a.latestAt));

  res.json({ me, contacts: groups });
});

// Mark a status as viewed.
router.post('/:id/view', (req, res) => {
  const s = db.prepare('SELECT * FROM statuses WHERE id = ?').get(req.params.id);
  if (!s || s.expires_at <= now()) return res.status(404).json({ error: 'status não encontrado' });
  if (s.user_id === req.user.id) return res.json({ ok: true }); // viewing my own
  if (isBlockedEither(req.user.id, s.user_id)) return res.status(403).json({ error: 'forbidden' });
  db.prepare(
    `INSERT INTO status_views (status_id, viewer_id, viewed_at) VALUES (?, ?, ?)
     ON CONFLICT(status_id, viewer_id) DO NOTHING`
  ).run(req.params.id, req.user.id, now());
  res.json({ ok: true });
});

// Who viewed my status (owner only).
router.get('/:id/viewers', (req, res) => {
  const s = db.prepare('SELECT * FROM statuses WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'não encontrado' });
  if (s.user_id !== req.user.id) return res.status(403).json({ error: 'apenas o autor' });
  const rows = db
    .prepare(
      `SELECT u.*, v.viewed_at FROM status_views v JOIN users u ON u.id = v.viewer_id
       WHERE v.status_id = ? ORDER BY v.viewed_at DESC`
    )
    .all(req.params.id);
  res.json({ viewers: rows.map((u) => ({ ...publicUser(u), viewedAt: u.viewed_at })) });
});

// Delete my status.
router.delete('/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM statuses WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'não encontrado' });
  if (s.user_id !== req.user.id) return res.status(403).json({ error: 'apenas o autor' });
  db.prepare('DELETE FROM statuses WHERE id = ?').run(req.params.id);
  bus.pushStatusUpdate(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
