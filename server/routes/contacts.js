'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { id, now, isValidEmail } = require('../util');
const { publicUserFor } = require('../chat-service');

const router = express.Router();
router.use(requireAuth);

// Serialize a contact row, attaching the linked SpeedVox user (if any) so the
// client can show an avatar and open a chat directly.
function serialize(row, viewerId) {
  let user = null;
  if (row.user_id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (u) user = publicUserFor(u, viewerId);
  }
  return {
    id: row.id,
    displayName: row.display_name,
    phone: row.phone || '',
    email: row.email || '',
    note: row.note || '',
    userId: row.user_id || null,
    user,
    createdAt: row.created_at,
  };
}

// List my contacts (alphabetical).
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM contacts WHERE owner_id = ? ORDER BY display_name COLLATE NOCASE')
    .all(req.user.id);
  res.json({ contacts: rows.map((r) => serialize(r, req.user.id)) });
});

// Create a contact.
router.post('/', (req, res) => {
  const b = req.body || {};
  const displayName = String(b.displayName || '').trim();
  if (!displayName) return res.status(400).json({ error: 'Informe o nome do contato' });
  const email = String(b.email || '').trim();
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });
  const phone = String(b.phone || '').trim().slice(0, 40);
  const note = String(b.note || '').trim().slice(0, 280);

  let userId = b.userId ? String(b.userId) : null;
  if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) userId = null;
  // Avoid duplicates when saving the same SpeedVox user twice.
  if (userId) {
    const dup = db.prepare('SELECT * FROM contacts WHERE owner_id = ? AND user_id = ?').get(req.user.id, userId);
    if (dup) return res.status(409).json({ error: 'Esse contato já está salvo', contact: serialize(dup, req.user.id) });
  }

  const cid = id();
  db.prepare(
    `INSERT INTO contacts (id, owner_id, user_id, display_name, phone, email, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(cid, req.user.id, userId, displayName, phone || null, email || null, note || null, now());
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  res.json({ contact: serialize(row, req.user.id) });
});

// Update a contact.
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Contato não encontrado' });
  const b = req.body || {};
  const fields = [];
  const values = [];
  if (typeof b.displayName === 'string' && b.displayName.trim()) { fields.push('display_name = ?'); values.push(b.displayName.trim()); }
  if (typeof b.phone === 'string') { fields.push('phone = ?'); values.push(b.phone.trim().slice(0, 40) || null); }
  if (typeof b.email === 'string') {
    const e = b.email.trim();
    if (e && !isValidEmail(e)) return res.status(400).json({ error: 'E-mail inválido' });
    fields.push('email = ?'); values.push(e || null);
  }
  if (typeof b.note === 'string') { fields.push('note = ?'); values.push(b.note.trim().slice(0, 280) || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
  values.push(req.params.id);
  db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  res.json({ contact: serialize(updated, req.user.id) });
});

// Delete a contact.
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM contacts WHERE id = ? AND owner_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Contato não encontrado' });
  res.json({ ok: true });
});

module.exports = router;
