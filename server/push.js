'use strict';

// Web Push notifications. Delivers a notification to a user's registered devices
// when a message arrives while they are not actively connected (and not muted).
// The push payload deliberately avoids leaking content for encrypted chats.

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const db = require('./db');
const config = require('./config');
const { now } = require('./util');
const { getMemberIds } = require('./chat-service');

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  subscription TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`);

let vapid = null;

function initVapid() {
  let pub = config.vapidPublic;
  let priv = config.vapidPrivate;
  if (!pub || !priv) {
    const file = path.join(config.dataDir, 'vapid.json');
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      pub = j.publicKey; priv = j.privateKey;
    } else {
      const keys = webpush.generateVAPIDKeys();
      pub = keys.publicKey; priv = keys.privateKey;
      if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(keys));
    }
  }
  vapid = { publicKey: pub, privateKey: priv };
  webpush.setVapidDetails(config.vapidSubject, pub, priv);
}
initVapid();

const isEnabled = () => Boolean(vapid && vapid.publicKey);
const getPublicKey = () => (vapid ? vapid.publicKey : null);

function saveSubscription(userId, sub) {
  if (!sub || !sub.endpoint) return;
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, subscription, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, subscription = excluded.subscription`
  ).run(sub.endpoint, userId, JSON.stringify(sub), now());
}

function removeSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function listForUser(userId) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
}

// Send a payload to every device of a user. Prunes expired/invalid subscriptions.
async function sendToUser(userId, payload) {
  if (!isEnabled()) return 0;
  let sent = 0;
  for (const row of listForUser(userId)) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify(payload));
      sent += 1;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) removeSubscription(row.endpoint);
    }
  }
  return sent;
}

// Members who should receive a push for a new message: everyone except the
// sender, who is not currently connected (app likely closed) and hasn't muted
// the chat. `isOnline` is injected to avoid a circular dependency with realtime.
function recipientsFor(chatId, senderId, isOnline) {
  const out = [];
  for (const memberId of getMemberIds(chatId)) {
    if (memberId === senderId) continue;
    if (typeof isOnline === 'function' && isOnline(memberId)) continue;
    const m = db
      .prepare('SELECT muted_until FROM chat_members WHERE chat_id = ? AND user_id = ?')
      .get(chatId, memberId);
    if (m && m.muted_until > now()) continue;
    out.push(memberId);
  }
  return out;
}

module.exports = {
  initVapid, isEnabled, getPublicKey,
  saveSubscription, removeSubscription, listForUser,
  sendToUser, recipientsFor,
};
