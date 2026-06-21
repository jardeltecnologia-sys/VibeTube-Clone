'use strict';

// Small event bus so REST routes can push realtime updates through Socket.IO.
// realtime.setup() injects the io instance via setIo().

const db = require('./db');
const { id, now } = require('./util');
const { getChatSummary, getMemberIds, serializeMessage, contactsOf } = require('./chat-service');

let io = null;
function setIo(instance) { io = instance; }

// Send each member their personalized chat summary.
function pushChatUpdate(chatId) {
  if (!io) return;
  for (const memberId of getMemberIds(chatId)) {
    io.to(`user:${memberId}`).emit('chat:update', getChatSummary(chatId, memberId));
  }
}

// Tell a specific user a chat is no longer theirs (left/removed).
function pushChatRemoved(chatId, userId) {
  if (!io) return;
  io.to(`user:${userId}`).emit('chat:removed', { chatId });
}

// Notify a user's contacts that their status feed changed.
function pushStatusUpdate(userId) {
  if (!io) return;
  for (const contactId of contactsOf(userId)) {
    io.to(`user:${contactId}`).emit('status:update', { userId });
  }
}

// Insert a system message and broadcast it to every member.
function systemMessage(chatId, body, senderId) {
  const mid = id();
  const ts = now();
  db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, type, body, created_at)
     VALUES (?, ?, ?, 'system', ?, ?)`
  ).run(mid, chatId, senderId, body, ts);
  const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(mid));
  if (io) {
    for (const memberId of getMemberIds(chatId)) {
      io.to(`user:${memberId}`).emit('message:new', { message });
    }
  }
  pushChatUpdate(chatId);
  return message;
}

module.exports = { setIo, pushChatUpdate, pushChatRemoved, pushStatusUpdate, systemMessage };
