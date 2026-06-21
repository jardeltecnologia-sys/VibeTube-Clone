'use strict';

// Multi-device linking. A new (logged-out) device requests a short-lived code
// and displays it (as text/QR). An already-authenticated device approves that
// code, which mints a session token the new device picks up by polling.

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth-middleware');
const { now, signToken } = require('../util');

const router = express.Router();
const TTL = 2 * 60 * 1000; // 2 minutes

function genCode() {
  // Human-friendly, unambiguous code.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 8; i++) c += alphabet[crypto.randomInt(alphabet.length)];
  return c;
}

// New device: create a pending link request.
router.post('/new', (req, res) => {
  let code = genCode();
  // Avoid the rare collision.
  while (db.prepare('SELECT 1 FROM link_requests WHERE code = ?').get(code)) code = genCode();
  const ts = now();
  db.prepare('INSERT INTO link_requests (code, token, created_at, expires_at) VALUES (?, NULL, ?, ?)')
    .run(code, ts, ts + TTL);
  res.json({ code, expiresIn: TTL });
});

// New device: poll for approval. Returns the token once (then consumes it).
router.get('/status', (req, res) => {
  const code = String(req.query.code || '').toUpperCase();
  const row = db.prepare('SELECT * FROM link_requests WHERE code = ?').get(code);
  if (!row) return res.json({ status: 'invalid' });
  if (row.expires_at <= now()) {
    db.prepare('DELETE FROM link_requests WHERE code = ?').run(code);
    return res.json({ status: 'expired' });
  }
  if (row.token) {
    db.prepare('DELETE FROM link_requests WHERE code = ?').run(code); // single use
    return res.json({ status: 'approved', token: row.token });
  }
  res.json({ status: 'pending' });
});

// Existing device (authenticated): approve a code, granting that device a session.
router.post('/approve', requireAuth, (req, res) => {
  const code = String((req.body && req.body.code) || '').toUpperCase();
  const row = db.prepare('SELECT * FROM link_requests WHERE code = ?').get(code);
  if (!row || row.expires_at <= now()) return res.status(404).json({ error: 'código inválido ou expirado' });
  if (row.token) return res.status(409).json({ error: 'código já utilizado' });
  const token = signToken(req.user);
  db.prepare('UPDATE link_requests SET token = ? WHERE code = ?').run(token, code);
  res.json({ ok: true });
});

module.exports = router;
