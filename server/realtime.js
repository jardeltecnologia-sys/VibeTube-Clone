'use strict';

const { Server } = require('socket.io');
const db = require('./db');
const { verifyToken, id, now, publicUser } = require('./util');
const {
  isMember, getMemberIds, serializeMessage, getChatSummary,
} = require('./chat-service');

// userId -> Set of socket ids
const online = new Map();

function isOnline(userId) {
  return online.has(userId) && online.get(userId).size > 0;
}

function setup(httpServer) {
  const io = new Server(httpServer, { maxHttpBufferSize: 1e7 });

  // Authenticate every socket from its handshake token.
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = token && verifyToken(token);
    if (!payload) return next(new Error('unauthorized'));
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    if (!user) return next(new Error('unauthorized'));
    socket.userId = user.id;
    socket.user = user;
    next();
  });

  // Notify a user's chat partners that their presence changed.
  function broadcastPresence(userId, status) {
    const chatIds = db
      .prepare('SELECT chat_id FROM chat_members WHERE user_id = ?')
      .all(userId)
      .map((r) => r.chat_id);
    const notified = new Set();
    for (const chatId of chatIds) {
      for (const memberId of getMemberIds(chatId)) {
        if (memberId === userId || notified.has(memberId)) continue;
        notified.add(memberId);
        io.to(`user:${memberId}`).emit('presence', {
          userId,
          status,
          lastSeen: status === 'offline' ? now() : null,
        });
      }
    }
  }

  // Deliver an event to every member of a chat via their personal room. This
  // guarantees delivery to all of a user's devices even for chats created after
  // they connected (no dependency on having joined the chat room yet).
  function emitToChat(chatId, event, payload, exceptUserId) {
    for (const memberId of getMemberIds(chatId)) {
      if (memberId === exceptUserId) continue;
      io.to(`user:${memberId}`).emit(event, payload);
    }
  }

  io.on('connection', (socket) => {
    const userId = socket.userId;
    const wasOffline = !isOnline(userId);
    if (!online.has(userId)) online.set(userId, new Set());
    online.get(userId).add(socket.id);

    // Personal room (for presence + cross-device delivery) and all chat rooms.
    socket.join(`user:${userId}`);
    for (const r of db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(userId)) {
      socket.join(`chat:${r.chat_id}`);
    }

    if (wasOffline) broadcastPresence(userId, 'online');

    // Client asks which of a list of users are currently online.
    socket.on('presence:query', (userIds, cb) => {
      const result = {};
      for (const uid of userIds || []) result[uid] = isOnline(uid);
      if (typeof cb === 'function') cb(result);
    });

    // --- Send a message ---
    socket.on('message:send', (payload, cb) => {
      try {
        const { chatId, body, type, mediaUrl, mediaName, mediaMime, replyTo, clientId } =
          payload || {};
        if (!isMember(chatId, userId)) {
          if (typeof cb === 'function') cb({ error: 'forbidden' });
          return;
        }
        const msgType = type || 'text';
        if (msgType === 'text' && (!body || !body.trim())) {
          if (typeof cb === 'function') cb({ error: 'mensagem vazia' });
          return;
        }
        const msgId = id();
        const ts = now();
        db.prepare(
          `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_mime, reply_to, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          msgId,
          chatId,
          userId,
          msgType,
          body ? body.trim() : null,
          mediaUrl || null,
          mediaName || null,
          mediaMime || null,
          replyTo || null,
          ts
        );
        const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
        emitToChat(chatId, 'message:new', { message, clientId });

        // Push an updated chat summary to every member's sidebar.
        for (const memberId of getMemberIds(chatId)) {
          io.to(`user:${memberId}`).emit('chat:update', getChatSummary(chatId, memberId));
        }
        if (typeof cb === 'function') cb({ ok: true, message });
      } catch (err) {
        console.error('message:send', err);
        if (typeof cb === 'function') cb({ error: 'erro interno' });
      }
    });

    // --- Typing indicator ---
    socket.on('typing', ({ chatId, isTyping }) => {
      if (!isMember(chatId, userId)) return;
      emitToChat(chatId, 'typing', {
        chatId,
        userId,
        displayName: socket.user.display_name,
        isTyping: Boolean(isTyping),
      }, userId);
    });

    // --- Read receipts: mark a chat as read up to now ---
    socket.on('chat:read', ({ chatId }) => {
      if (!isMember(chatId, userId)) return;
      const ts = now();
      db.prepare('UPDATE chat_members SET last_read_at = ? WHERE chat_id = ? AND user_id = ?').run(
        ts,
        chatId,
        userId
      );
      const unread = db
        .prepare(
          `SELECT id FROM messages WHERE chat_id = ? AND sender_id != ?
           AND id NOT IN (SELECT message_id FROM receipts WHERE user_id = ? AND status = 'read')`
        )
        .all(chatId, userId, userId);
      const stmt = db.prepare(
        `INSERT INTO receipts (message_id, user_id, status, at) VALUES (?, ?, 'read', ?)
         ON CONFLICT(message_id, user_id) DO UPDATE SET status='read', at=excluded.at`
      );
      for (const m of unread) stmt.run(m.id, userId, ts);
      emitToChat(chatId, 'receipt', { chatId, userId, status: 'read', at: ts });
      io.to(`user:${userId}`).emit('chat:update', getChatSummary(chatId, userId));
    });

    // --- Delivered receipt for a single message ---
    socket.on('message:delivered', ({ messageId, chatId }) => {
      if (!messageId) return;
      db.prepare(
        `INSERT INTO receipts (message_id, user_id, status, at) VALUES (?, ?, 'delivered', ?)
         ON CONFLICT(message_id, user_id) DO NOTHING`
      ).run(messageId, userId, now());
      if (chatId) emitToChat(chatId, 'receipt', { chatId, messageId, userId, status: 'delivered' });
    });

    // --- React to a message ---
    socket.on('message:react', ({ messageId, emoji }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || !isMember(msg.chat_id, userId)) return;
      const existing = db
        .prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?')
        .get(messageId, userId);
      if (existing && existing.emoji === emoji) {
        db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
      } else {
        db.prepare(
          `INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
           ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji`
        ).run(messageId, userId, emoji);
      }
      const reactions = db.prepare('SELECT user_id, emoji FROM reactions WHERE message_id = ?').all(messageId);
      emitToChat(msg.chat_id, 'message:reaction', { messageId, reactions });
    });

    // --- Delete a message (sender only) ---
    socket.on('message:delete', ({ messageId }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.sender_id !== userId) return;
      db.prepare('UPDATE messages SET deleted = 1, body = NULL WHERE id = ?').run(messageId);
      emitToChat(msg.chat_id, 'message:deleted', { messageId, chatId: msg.chat_id });
    });

    // --- Join a freshly created chat room (e.g. just created a group) ---
    socket.on('chat:join', ({ chatId }) => {
      if (isMember(chatId, userId)) socket.join(`chat:${chatId}`);
    });

    // --- WebRTC / mesh signaling relay (peer-to-peer fallback for blackout mode) ---
    socket.on('mesh:signal', ({ to, signal }) => {
      if (!to) return;
      io.to(`user:${to}`).emit('mesh:signal', { from: userId, signal });
    });

    // --- Voice / video call signaling (1:1 WebRTC) ---
    // The server only relays signaling; media flows peer-to-peer.
    socket.on('call:invite', ({ to, callId, media, chatId }) => {
      if (!to || !callId) return;
      if (!isOnline(to)) {
        socket.emit('call:unavailable', { callId, reason: 'offline' });
        return;
      }
      io.to(`user:${to}`).emit('call:incoming', {
        from: publicUser(socket.user),
        callId,
        media: media === 'video' ? 'video' : 'audio',
        chatId,
      });
    });
    socket.on('call:accept', ({ to, callId }) => {
      io.to(`user:${to}`).emit('call:accepted', { from: userId, callId });
    });
    socket.on('call:reject', ({ to, callId }) => {
      io.to(`user:${to}`).emit('call:rejected', { from: userId, callId });
    });
    socket.on('call:sdp', ({ to, callId, sdp }) => {
      io.to(`user:${to}`).emit('call:sdp', { from: userId, callId, sdp });
    });
    socket.on('call:ice', ({ to, callId, candidate }) => {
      io.to(`user:${to}`).emit('call:ice', { from: userId, callId, candidate });
    });
    socket.on('call:end', ({ to, callId }) => {
      io.to(`user:${to}`).emit('call:ended', { from: userId, callId });
    });

    socket.on('disconnect', () => {
      const set = online.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(userId);
          db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
          broadcastPresence(userId, 'offline');
        }
      }
    });
  });

  return io;
}

module.exports = { setup, isOnline };
