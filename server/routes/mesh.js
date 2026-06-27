'use strict';

// VibeTube Mesh / SpeedVox Offline Mode — backend (Phase 1).
//
// Additive endpoints that never touch the existing online flow:
//   GET  /api/mesh/status          — is the mesh backend available?
//   GET  /api/mesh/config          — limits/params for clients
//   POST /api/mesh/register-device — register an offline device's public identity
//   POST /api/mesh/sync            — accept a batch of offline (relayed) messages
//
// Auth is OPTIONAL on register/sync: an offline identity can exist without a
// SpeedVox login, but if a valid token is present we link it to the account.
// Phase 1 does "validação básica" (shape + limits + dedup). Cryptographic
// signature verification with mesh-core is a later hardening phase.

const express = require('express');
const config = require('../config');
const db = require('../db');
const { id, now } = require('../util');
const { verifyToken } = require('../util');
const { getTokenFromReq } = require('../auth-middleware');

const router = express.Router();

const VALID_TYPES = new Set(['chat', 'direct', 'presence', 'ack', 'sync', 'system']);

// Resolve an optional logged-in user from the request (null if anonymous).
function optionalUser(req) {
  const token = getTokenFromReq(req);
  const payload = token && verifyToken(token);
  if (!payload) return null;
  return db.prepare('SELECT id FROM users WHERE id = ?').get(payload.sub) || null;
}

function meshGate(req, res, next) {
  if (!config.mesh.enabled) return res.status(503).json({ error: 'mesh disabled' });
  next();
}

// Public: clients probe whether the backend speaks mesh sync.
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    enabled: config.mesh.enabled,
    syncEnabled: config.mesh.enabled && config.mesh.syncEnabled,
    androidEnabled: config.mesh.androidEnabled,
    webDiagnosticOnly: config.mesh.webDiagnosticOnly,
    serverTime: now(),
  });
});

// Public: limits/params the client must respect.
router.get('/config', (req, res) => {
  res.json({
    enabled: config.mesh.enabled,
    maxMessageBytes: config.mesh.maxMessageBytes,
    maxBatchSize: config.mesh.maxBatchSize,
    maxTTL: config.mesh.maxTTL,
    maxOfflineRetentionDays: config.mesh.maxOfflineRetentionDays,
    allowAttachmentsOffline: config.mesh.allowAttachmentsOffline,
  });
});

// Register (or refresh) an offline device's public identity.
router.post('/register-device', meshGate, (req, res) => {
  const { deviceId, publicKey, displayName } = req.body || {};
  if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 128) {
    return res.status(400).json({ error: 'deviceId inválido' });
  }
  // publicKey is the shareable public bundle; accept object or string, store JSON.
  let pk;
  try {
    pk = typeof publicKey === 'string' ? publicKey : JSON.stringify(publicKey);
  } catch { pk = null; }
  if (!pk || pk.length > config.mesh.maxMessageBytes) {
    return res.status(400).json({ error: 'publicKey inválida' });
  }
  const user = optionalUser(req);
  const ts = now();
  const existing = db.prepare('SELECT device_id, first_seen_at FROM mesh_devices WHERE device_id = ?').get(deviceId);
  if (existing) {
    db.prepare(
      'UPDATE mesh_devices SET public_key = ?, display_name = ?, user_id = COALESCE(?, user_id), last_seen_at = ? WHERE device_id = ?'
    ).run(pk, displayName ? String(displayName).slice(0, 80) : null, user ? user.id : null, ts, deviceId);
  } else {
    db.prepare(
      'INSERT INTO mesh_devices (device_id, public_key, display_name, user_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(deviceId, pk, displayName ? String(displayName).slice(0, 80) : null, user ? user.id : null, ts, ts);
  }
  res.json({ ok: true, deviceId, linkedUser: user ? user.id : null });
});

// Accept a batch of offline messages a device relayed while disconnected.
router.post('/sync', meshGate, (req, res) => {
  if (!config.mesh.syncEnabled) return res.status(503).json({ error: 'sync disabled' });
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return res.status(400).json({ error: 'messages deve ser uma lista' });
  if (messages.length > config.mesh.maxBatchSize) {
    return res.status(413).json({ error: `lote acima do limite (${config.mesh.maxBatchSize})` });
  }

  const accepted = [];
  const rejected = [];
  const duplicates = [];
  const ts = now();
  const retentionMs = config.mesh.maxOfflineRetentionDays * 24 * 60 * 60 * 1000;

  const findStmt = db.prepare('SELECT message_id FROM mesh_messages WHERE message_id = ?');
  const insertStmt = db.prepare(
    `INSERT INTO mesh_messages (message_id, type, from_device_id, to_device_id, room_id, envelope, created_at, received_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const m of messages) {
    const reason = validateEnvelope(m);
    if (reason) { rejected.push({ messageId: m && m.messageId, reason }); continue; }
    if (findStmt.get(m.messageId)) { duplicates.push(m.messageId); continue; }
    insertStmt.run(
      m.messageId,
      m.type,
      m.fromDeviceId || null,
      m.toDeviceId || null,
      m.roomId || null,
      JSON.stringify(m),
      m.createdAt,
      ts,
      ts + retentionMs,
    );
    accepted.push(m.messageId);
  }

  res.json({ accepted, rejected, duplicates, serverTime: ts });
});

// Pull offline messages relayed by OTHER devices since a cursor. This bridges
// offline "islands": a device that briefly gets internet uploads (sync) what it
// relayed; peers pull it when they get internet. Cursor = received_at; clients
// dedup by messageId, so same-millisecond ties are harmless.
router.get('/pull', meshGate, (req, res) => {
  if (!config.mesh.syncEnabled) return res.status(503).json({ error: 'sync disabled' });
  const since = Number(req.query.since) || 0;
  const deviceId = req.query.deviceId ? String(req.query.deviceId) : null;
  const limit = Math.min(Number(req.query.limit) || config.mesh.maxBatchSize, config.mesh.maxBatchSize);
  const ts = now();
  const rows = db.prepare(
    `SELECT envelope, received_at FROM mesh_messages
     WHERE received_at > ? AND (expires_at IS NULL OR expires_at > ?)
       AND (CAST(? AS TEXT) IS NULL OR from_device_id IS NULL OR from_device_id != ?)
     ORDER BY received_at ASC LIMIT ?`
  ).all(since, ts, deviceId, deviceId, limit);
  const messages = [];
  let cursor = since;
  for (const r of rows) {
    try { messages.push(JSON.parse(r.envelope)); } catch { /* skip corrupt */ }
    cursor = r.received_at;
  }
  res.json({ messages, cursor, serverTime: ts });
});

// Structural ("básica") validation. Returns null if OK, else a reason string.
function validateEnvelope(m) {
  if (!m || typeof m !== 'object') return 'not-an-object';
  if (m.version !== 1) return 'bad-version';
  if (typeof m.messageId !== 'string' || !m.messageId) return 'missing-messageId';
  if (!VALID_TYPES.has(m.type)) return 'bad-type';
  if (typeof m.createdAt !== 'number') return 'bad-createdAt';
  if (typeof m.ttl !== 'number' || m.ttl < 0 || m.ttl > config.mesh.maxTTL) return 'bad-ttl';
  if (!m.signature || !m.fromDeviceId || !m.fromPublicKey) return 'unsigned';
  let size;
  try { size = Buffer.byteLength(JSON.stringify(m), 'utf8'); } catch { return 'unserializable'; }
  if (size > config.mesh.maxMessageBytes) return 'too-large';
  return null;
}

module.exports = router;
