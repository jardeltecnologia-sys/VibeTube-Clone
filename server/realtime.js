'use strict';

const { Server } = require('socket.io');
const db = require('./db');
const config = require('./config');
const { verifyToken, id, now, publicUser } = require('./util');
const {
  isMember, getMemberIds, serializeMessage, getChatSummary, iBlocked, isBlockedEither,
  findOrCreateDirectChat,
} = require('./chat-service');
const push = require('./push');
const fcm = require('./fcm');

// In-flight calls, keyed by callId. Used to log history and detect missed calls.
const activeCalls = new Map();

// Privacy-aware push preview: never reveals content of encrypted messages.
function pushPreview(message) {
  if (message.encrypted) return 'Nova mensagem';
  switch (message.type) {
    case 'image': return '📷 Foto';
    case 'audio': return '🎤 Mensagem de voz';
    case 'file': return `📎 ${message.mediaName || 'Arquivo'}`;
    default: return message.body || 'Nova mensagem';
  }
}

// userId -> Set of socket ids
const online = new Map();

function isOnline(userId) {
  return online.has(userId) && online.get(userId).size > 0;
}

function setup(httpServer) {
  const io = new Server(httpServer, {
    maxHttpBufferSize: 1e7,
    // Allow the bundled native app's local origin to connect (web stays same-origin).
    cors: { origin: config.corsOrigins, credentials: true },
  });
  require('./bus').setIo(io); // let REST routes push realtime updates

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
    // Respect the "last seen / online" privacy setting.
    const pref = db.prepare('SELECT privacy_last_seen FROM users WHERE id = ?').get(userId);
    if (pref && pref.privacy_last_seen === 'nobody') return;
    const chatIds = db
      .prepare('SELECT chat_id FROM chat_members WHERE user_id = ?')
      .all(userId)
      .map((r) => r.chat_id);
    const notified = new Set();
    for (const chatId of chatIds) {
      for (const memberId of getMemberIds(chatId)) {
        if (memberId === userId || notified.has(memberId)) continue;
        notified.add(memberId);
        if (isBlockedEither(userId, memberId)) continue; // hide presence across a block
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

  const audioService = require('./utils/audioService');
  audioService.setSocketIo(io, emitToChat);

  // Finalize a call: record it as a message in the 1:1 chat (history) and, for a
  // missed/rejected call, push the callee. status: completed|missed|rejected|canceled.
  function logCall(callId, status) {
    const call = activeCalls.get(callId);
    if (!call || call.logged) return;
    call.logged = true;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    activeCalls.delete(callId);

    // Both participants must be real users to record the call.
    const bothExist = db.prepare('SELECT COUNT(*) AS c FROM users WHERE id IN (?, ?)')
      .get(call.callerId, call.calleeId).c === 2;
    if (!bothExist) return;

    const chatId = findOrCreateDirectChat(call.callerId, call.calleeId);
    const duration = call.answeredAt ? Math.max(0, Math.round((now() - call.answeredAt) / 1000)) : 0;
    const body = JSON.stringify({ media: call.media, status, duration });
    const msgId = id();
    const ts = now();
    db.prepare(
      `INSERT INTO messages (id, chat_id, sender_id, type, body, created_at)
       VALUES (?, ?, ?, 'call', ?, ?)`
    ).run(msgId, chatId, call.callerId, body, ts);
    const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));
    for (const memberId of [call.callerId, call.calleeId]) {
      io.to(`user:${memberId}`).emit('message:new', { message });
      io.to(`user:${memberId}`).emit('chat:update', getChatSummary(chatId, memberId));
    }
    if ((status === 'missed' || status === 'rejected') && push.isEnabled() && !isOnline(call.calleeId)) {
      const caller = db.prepare('SELECT display_name FROM users WHERE id = ?').get(call.callerId);
      push.sendToUser(call.calleeId, {
        title: caller ? caller.display_name : 'SpeedVox',
        body: status === 'missed' ? '📞 Chamada perdida' : '📞 Chamada recusada',
        chatId, tag: `call-${chatId}`,
      }).catch(() => {});
    }
  }

  // chatId -> Set<userId> currently in a group call (full-mesh WebRTC).
  const groupCalls = new Map();

  function gcallLeave(chatId, leaverId) {
    const room = groupCalls.get(chatId);
    if (!room || !room.has(leaverId)) return;
    room.delete(leaverId);
    for (const pid of room) io.to(`user:${pid}`).emit('gcall:peer-leave', { chatId, userId: leaverId });
    if (room.size === 0) {
      groupCalls.delete(chatId);
      for (const memberId of getMemberIds(chatId)) {
        io.to(`user:${memberId}`).emit('gcall:ended', { chatId });
      }
    }
  }

  // Fire-and-forget Web Push for a new message.
  function notifyPush(chatId, sender, message) {
    if (!push.isEnabled()) return;
    const targets = new Set(push.recipientsFor(chatId, sender.id, isOnline));
    // Mentions notify even if the chat is muted (still only when offline).
    for (const uid of message.mentions || []) {
      if (uid !== sender.id && !isOnline(uid) && isMember(chatId, uid)) targets.add(uid);
    }
    if (!targets.size) return;
    const chat = db.prepare('SELECT type, name FROM chats WHERE id = ?').get(chatId);
    const isGroup = chat && chat.type === 'group';
    const title = isGroup ? (chat.name || 'Grupo') : sender.display_name;
    let body = pushPreview(message);
    if (isGroup) body = `${sender.display_name}: ${body}`;
    const payload = { title, body, chatId, tag: chatId };
    for (const uid of targets) push.sendToUser(uid, payload).catch(() => {});
  }

  // Fire-and-forget Web Push for an INCOMING CALL (callee's app is closed). The
  // notification wakes the device; when the app opens and reconnects, the server
  // delivers the still-ringing call (see the connection handler).
  function notifyIncomingCall(toUserId, caller, callId, media, chatId) {
    // Native Android (FCM): rings full-screen even with the app closed.
    fcm.sendCall(toUserId, { caller: caller.display_name || 'Chamada', callId, media }).catch(() => {});
    // Web Push fallback (PWA): wakes the device with a notification.
    if (!push.isEnabled()) return;
    push.sendToUser(toUserId, {
      type: 'call',
      title: `📞 ${caller.display_name || 'Chamada'}`,
      body: media === 'video' ? 'Chamada de vídeo recebida' : 'Chamada de voz recebida',
      callId,
      media,
      chatId: chatId || null,
      tag: `call-${callId}`,
      renotify: true,
      requireInteraction: true,
    }).catch(() => {});
  }

  // Deliver scheduled messages whose time has come.
  function deliverScheduled() {
    const due = db
      .prepare('SELECT * FROM messages WHERE send_at IS NOT NULL AND send_at <= ?')
      .all(now());
    for (const row of due) {
      db.prepare('UPDATE messages SET send_at = NULL WHERE id = ?').run(row.id);
      const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id));
      emitToChat(row.chat_id, 'message:new', { message });
      for (const memberId of getMemberIds(row.chat_id)) {
        io.to(`user:${memberId}`).emit('chat:update', getChatSummary(row.chat_id, memberId));
      }
      const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(row.sender_id);
      if (sender) notifyPush(row.chat_id, sender, message);
    }
  }

  // Periodically delete expired (disappearing) messages and notify members.
  function sweepExpired() {
    deliverScheduled();
    // Expired statuses (24h stories) and stale device-link codes are removed.
    db.prepare('DELETE FROM statuses WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM link_requests WHERE expires_at <= ?').run(now());
    const expired = db
      .prepare('SELECT id, chat_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .all(now());
    if (!expired.length) return;
    const chatsTouched = new Set();
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const row of expired) {
      del.run(row.id);
      for (const memberId of getMemberIds(row.chat_id)) {
        io.to(`user:${memberId}`).emit('message:expired', { messageId: row.id, chatId: row.chat_id });
      }
      chatsTouched.add(row.chat_id);
    }
    for (const chatId of chatsTouched) {
      for (const memberId of getMemberIds(chatId)) {
        io.to(`user:${memberId}`).emit('chat:update', getChatSummary(chatId, memberId));
      }
    }
  }
  const sweepTimer = setInterval(sweepExpired, config.sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

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

    // WhatsApp-style: if someone called while this user's app was closed, the
    // call is still ringing on the server — deliver it so the app rings as soon
    // as it opens (e.g. from tapping the call push notification). Small delay so
    // an app that just booted has time to attach its call handlers.
    setTimeout(() => {
      if (!isOnline(userId)) return;
      for (const [cid, call] of activeCalls) {
        if (call.calleeId === userId && !call.answeredAt && !call.logged) {
          const caller = db.prepare('SELECT * FROM users WHERE id = ?').get(call.callerId);
          if (caller) {
            io.to(`user:${userId}`).emit('call:incoming', {
              from: publicUser(caller), callId: cid, media: call.media, chatId: call.chatId || null,
            });
          }
        }
      }
    }, 800);

    // Client asks which of a list of users are currently online.
    socket.on('presence:query', (userIds, cb) => {
      const result = {};
      for (const uid of userIds || []) result[uid] = isOnline(uid);
      if (typeof cb === 'function') cb(result);
    });

    // --- Send a message ---
    socket.on('message:send', (payload, cb) => {
      try {
        const { chatId, body, type, mediaUrl, mediaName, mediaMime, replyTo, clientId, encrypted, forwarded, mentions } =
          payload || {};
        if (!isMember(chatId, userId)) {
          if (typeof cb === 'function') cb({ error: 'forbidden' });
          return;
        }
        // Blocking: figure out the 1:1 partner and whether a block is in effect.
        const others = getMemberIds(chatId).filter((m) => m !== userId);
        const partner = others.length === 1 ? others[0] : null;
        if (partner && iBlocked(userId, partner)) {
          if (typeof cb === 'function') {
            cb({ error: 'Você bloqueou este contato. Desbloqueie para enviar mensagens.' });
          }
          return;
        }
        const shieldedByPartner = partner ? iBlocked(partner, userId) : false;
        const msgType = type || 'text';
        if (msgType === 'text' && (!body || !body.trim())) {
          if (typeof cb === 'function') cb({ error: 'mensagem vazia' });
          return;
        }
        // Polls (Telegram-style): body carries { question, options[], multi }.
        if (msgType === 'poll') {
          let meta;
          try { meta = JSON.parse(body); } catch { meta = null; }
          const opts = meta && Array.isArray(meta.options)
            ? meta.options.map((o) => String(o).trim()).filter(Boolean) : [];
          if (!meta || !String(meta.question || '').trim() || opts.length < 2 || opts.length > 10) {
            if (typeof cb === 'function') cb({ error: 'enquete inválida' });
            return;
          }
        }
        const msgId = id();
        const ts = now();
        // Scheduled messages: held back (invisible) until the sweeper delivers.
        const sendAt = Number(payload.sendAt) || 0;
        const scheduled = sendAt > ts + 2000;
        // Encrypted bodies are opaque ciphertext — keep them verbatim (no trim).
        const storedBody = encrypted ? body : (body ? body.trim() : null);
        // Disappearing messages: stamp an expiry if the chat has a timer set
        // (counted from delivery time for scheduled messages).
        const chatRow = db.prepare('SELECT disappearing_timer FROM chats WHERE id = ?').get(chatId);
        const timer = chatRow ? chatRow.disappearing_timer : 0;
        const baseTime = scheduled ? sendAt : ts;
        const expiresAt = timer > 0 ? baseTime + timer * 1000 : null;
        // Keep only mentions that are actual members of this chat.
        const validMentions = Array.isArray(mentions)
          ? [...new Set(mentions)].filter((uid) => isMember(chatId, uid)) : [];
        db.prepare(
          `INSERT INTO messages (id, chat_id, sender_id, type, body, media_url, media_name, media_mime, reply_to, encrypted, forwarded, expires_at, mentions, send_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          msgId,
          chatId,
          userId,
          msgType,
          storedBody,
          mediaUrl || null,
          mediaName || null,
          mediaMime || null,
          replyTo || null,
          encrypted ? 1 : 0,
          forwarded ? 1 : 0,
          expiresAt,
          validMentions.length ? JSON.stringify(validMentions) : null,
          scheduled ? sendAt : null,
          scheduled ? sendAt : ts
        );

        // Scheduled: store and stop here — the sweeper delivers it when due.
        if (scheduled) {
          if (typeof cb === 'function') cb({ ok: true, scheduled: true, sendAt });
          return;
        }

        const message = serializeMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(msgId));

        if (shieldedByPartner) {
          // The recipient blocked me: I see the message as sent, but it is never
          // delivered to them (and the block filter hides it from their views).
          io.to(`user:${userId}`).emit('message:new', { message, clientId });
          io.to(`user:${userId}`).emit('chat:update', getChatSummary(chatId, userId));
          if (typeof cb === 'function') cb({ ok: true, message });
          return;
        }

        emitToChat(chatId, 'message:new', { message, clientId });

        if (msgType === 'audio' && mediaUrl) {
          const path = require('path');
          const filename = path.basename(mediaUrl);
          audioService.transcribeAndSummarize(msgId, filename).catch(() => {});
        }

        // Push an updated chat summary to every member's sidebar.
        for (const memberId of getMemberIds(chatId)) {
          io.to(`user:${memberId}`).emit('chat:update', getChatSummary(chatId, memberId));
        }

        // Web Push to recipients who are offline (and haven't muted the chat).
        notifyPush(chatId, socket.user, message);

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
      // Always refresh my own unread count.
      io.to(`user:${userId}`).emit('chat:update', getChatSummary(chatId, userId));

      // Read receipts are reciprocal: if I disabled them, I neither send nor
      // (below) receive blue ticks.
      const myRR = db.prepare('SELECT read_receipts FROM users WHERE id = ?').get(userId).read_receipts;
      if (!myRR) return;

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
      // Emit my read receipt only to members who also keep read receipts on.
      for (const memberId of getMemberIds(chatId)) {
        const rr = db.prepare('SELECT read_receipts FROM users WHERE id = ?').get(memberId).read_receipts;
        if (rr) io.to(`user:${memberId}`).emit('receipt', { chatId, userId, status: 'read', at: ts });
      }
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

    // --- Vote in a poll ---
    socket.on('poll:vote', ({ messageId, option }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.type !== 'poll' || msg.deleted || !isMember(msg.chat_id, userId)) return;
      let meta;
      try { meta = JSON.parse(msg.body); } catch { return; }
      const idx = Number(option);
      if (!Number.isInteger(idx) || idx < 0 || idx >= meta.options.length) return;
      const has = db.prepare('SELECT 1 FROM poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?')
        .get(messageId, userId, idx);
      if (has) {
        db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?')
          .run(messageId, userId, idx);
      } else {
        if (!meta.multi) db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(messageId, userId);
        db.prepare('INSERT OR IGNORE INTO poll_votes (message_id, user_id, option_index) VALUES (?, ?, ?)')
          .run(messageId, userId, idx);
      }
      const votes = db.prepare('SELECT user_id, option_index FROM poll_votes WHERE message_id = ?').all(messageId);
      emitToChat(msg.chat_id, 'poll:update', {
        messageId, chatId: msg.chat_id, votes: votes.map((v) => ({ userId: v.user_id, option: v.option_index })),
      });
    });

    // --- Edit a text message (sender only) ---
    socket.on('message:edit', ({ messageId, body, encrypted }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.sender_id !== userId || msg.deleted || msg.type !== 'text') return;
      if (!body || (!encrypted && !body.trim())) return;
      const ts = now();
      const stored = encrypted ? body : body.trim();
      db.prepare('UPDATE messages SET body = ?, encrypted = ?, edited_at = ? WHERE id = ?')
        .run(stored, encrypted ? 1 : 0, ts, messageId);
      emitToChat(msg.chat_id, 'message:edited', {
        messageId, chatId: msg.chat_id, body: stored, encrypted: Boolean(encrypted), editedAt: ts,
      });
    });

    // --- Delete a message (sender only) ---
    socket.on('message:delete', ({ messageId }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.sender_id !== userId) return;
      if (msg.send_at && msg.send_at > now()) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
        socket.emit('message:deleted', { messageId, chatId: msg.chat_id });
        return;
      }
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

    socket.on('call:watchparty', ({ to, payload }) => {
      if (!to) return;
      io.to(`user:${to}`).emit('call:watchparty', { from: userId, payload });
    });

    // --- Voice / video call signaling (1:1 WebRTC) ---
    // The server only relays signaling; media flows peer-to-peer.
    socket.on('call:invite', ({ to, callId, media, chatId }) => {
      if (!to || !callId) return;
      const callMedia = media === 'video' ? 'video' : 'audio';
      // Blocking: cannot call a contact you blocked (or who blocked you).
      if (isBlockedEither(userId, to)) {
        socket.emit('call:unavailable', { callId, reason: 'blocked' });
        return;
      }

      const calleeOnline = isOnline(to);
      // App closed AND no way to wake them (no Web Push and no native FCM token):
      // tell the caller immediately instead of ringing into the void.
      const canWake = push.hasSubscription(to) || fcm.tokensFor(to).length > 0;
      if (!calleeOnline && !canWake) {
        activeCalls.set(callId, { callerId: userId, calleeId: to, media: callMedia, startedAt: now() });
        socket.emit('call:unavailable', { callId, reason: 'offline' });
        logCall(callId, 'missed');
        return;
      }

      // Keep the call ringing for the whole window; if unanswered, mark missed.
      const ringTimer = setTimeout(() => {
        const call = activeCalls.get(callId);
        if (call && !call.answeredAt) {
          io.to(`user:${to}`).emit('call:ended', { from: userId, callId });
          io.to(`user:${userId}`).emit('call:ended', { from: to, callId });
          logCall(callId, 'missed');
        }
      }, config.callRingMs);
      activeCalls.set(callId, {
        callerId: userId, calleeId: to, media: callMedia, chatId: chatId || null,
        startedAt: now(), ringTimer,
      });

      if (calleeOnline) {
        // App open on at least one device: ring it now.
        io.to(`user:${to}`).emit('call:incoming', {
          from: publicUser(socket.user), callId, media: callMedia, chatId,
        });
      } else {
        // App closed but reachable: wake the device via push. When it opens and
        // reconnects, the connection handler delivers this still-ringing call.
        notifyIncomingCall(to, socket.user, callId, callMedia, chatId);
      }
    });
    socket.on('call:accept', ({ to, callId }) => {
      const call = activeCalls.get(callId);
      if (call) { call.answeredAt = now(); if (call.ringTimer) clearTimeout(call.ringTimer); }
      io.to(`user:${to}`).emit('call:accepted', { from: userId, callId });
    });
    socket.on('call:reject', ({ to, callId }) => {
      io.to(`user:${to}`).emit('call:rejected', { from: userId, callId });
      logCall(callId, 'rejected');
    });
    socket.on('call:sdp', ({ to, callId, sdp }) => {
      io.to(`user:${to}`).emit('call:sdp', { from: userId, callId, sdp });
    });
    socket.on('call:ice', ({ to, callId, candidate }) => {
      io.to(`user:${to}`).emit('call:ice', { from: userId, callId, candidate });
    });
    socket.on('call:end', ({ to, callId }) => {
      io.to(`user:${to}`).emit('call:ended', { from: userId, callId });
      const call = activeCalls.get(callId);
      if (call) logCall(callId, call.answeredAt ? 'completed' : 'canceled');
    });

    // --- Group calls: full-mesh WebRTC over a per-chat call room ---
    socket.on('gcall:join', ({ chatId, media }, cb) => {
      const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId);
      if (!chat || chat.type !== 'group' || !isMember(chatId, userId)) {
        if (typeof cb === 'function') cb({ error: 'forbidden' });
        return;
      }
      const callMedia = media === 'video' ? 'video' : 'audio';
      let room = groupCalls.get(chatId);
      const firstJoin = !room || room.size === 0;
      if (!room) { room = new Set(); groupCalls.set(chatId, room); }
      const existing = [...room];
      room.add(userId);
      // The newcomer offers to everyone already present.
      if (typeof cb === 'function') cb({ participants: existing });
      for (const pid of existing) {
        io.to(`user:${pid}`).emit('gcall:peer-join', { chatId, userId, media: callMedia });
      }
      // Ring the rest of the group when a call starts.
      if (firstJoin) {
        for (const memberId of getMemberIds(chatId)) {
          if (memberId === userId || isBlockedEither(userId, memberId)) continue;
          io.to(`user:${memberId}`).emit('gcall:incoming', {
            chatId, from: publicUser(socket.user), media: callMedia,
          });
        }
      }
    });
    socket.on('gcall:signal', ({ chatId, to, signal }) => {
      if (!to) return;
      io.to(`user:${to}`).emit('gcall:signal', { chatId, from: userId, signal });
    });
    socket.on('gcall:leave', ({ chatId }) => gcallLeave(chatId, userId));

    socket.on('disconnect', () => {
      const set = online.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          online.delete(userId);
          db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), userId);
          broadcastPresence(userId, 'offline');
          // End any 1:1 call this user was part of.
          for (const [cid, call] of activeCalls) {
            if (call.callerId === userId || call.calleeId === userId) {
              const other = call.callerId === userId ? call.calleeId : call.callerId;
              io.to(`user:${other}`).emit('call:ended', { from: userId, callId: cid });
              logCall(cid, call.answeredAt ? 'completed' : (call.calleeId === userId ? 'missed' : 'canceled'));
            }
          }
          // Leave any group calls.
          for (const [cid, room] of groupCalls) {
            if (room.has(userId)) gcallLeave(cid, userId);
          }
        }
      }
    });
  });

  return io;
}

module.exports = { setup, isOnline };
