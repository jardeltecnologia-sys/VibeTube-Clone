'use strict';

const db = require('./db');
const { id, now, publicUser } = require('./util');

// --- Blocking helpers ---
function iBlocked(blockerId, blockedId) {
  return Boolean(
    db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId)
  );
}
function blockRow(blockerId, blockedId) {
  return db.prepare('SELECT * FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId);
}
function isBlockedEither(a, b) {
  return iBlocked(a, b) || iBlocked(b, a);
}

// Users who share at least one chat with `userId` (the natural "contacts"
// graph), excluding anyone with a block relationship.
function contactsOf(userId) {
  const rows = db
    .prepare(
      `SELECT DISTINCT cm2.user_id AS uid
       FROM chat_members cm1
       JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id AND cm2.user_id != cm1.user_id
       WHERE cm1.user_id = ?`
    )
    .all(userId);
  return rows.map((r) => r.uid).filter((uid) => !isBlockedEither(userId, uid));
}

// Whether `adderId` is allowed to add `targetId` to a group, per target's privacy.
function canAddToGroup(targetId, adderId) {
  const t = db.prepare('SELECT privacy_groups FROM users WHERE id = ?').get(targetId);
  const setting = (t && t.privacy_groups) || 'everyone';
  if (setting === 'everyone') return true;
  if (setting === 'nobody') return false;
  return contactsOf(targetId).includes(adderId); // 'contacts'
}

// Do two users share at least one chat?
function sharesChat(a, b) {
  return Boolean(
    db.prepare(
      `SELECT 1 FROM chat_members m1 JOIN chat_members m2 ON m1.chat_id = m2.chat_id
       WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`
    ).get(a, b)
  );
}

// Viewer-aware public projection: applies photo/about/last-seen privacy.
function publicUserFor(u, viewerId) {
  const base = publicUser(u);
  if (!u || !viewerId || viewerId === u.id) return base;
  let contactKnown = null;
  const isContact = () => {
    if (contactKnown === null) contactKnown = sharesChat(viewerId, u.id) && !isBlockedEither(viewerId, u.id);
    return contactKnown;
  };
  const allow = (setting) => {
    if (setting === 'nobody') return false;
    if (setting === 'contacts') return isContact();
    return true;
  };
  if (!allow(u.privacy_photo || 'everyone')) base.avatarUrl = null;
  if (!allow(u.privacy_about || 'everyone')) base.about = '';
  if ((u.privacy_last_seen || 'everyone') === 'contacts' && !isContact()) base.lastSeen = null;
  return base;
}

function isMember(chatId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId)
  );
}

function getMemberIds(chatId) {
  return db
    .prepare('SELECT user_id FROM chat_members WHERE chat_id = ?')
    .all(chatId)
    .map((r) => r.user_id);
}

function getMembers(chatId, viewerId) {
  return db
    .prepare(
      `SELECT u.*, m.role FROM chat_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.chat_id = ?`
    )
    .all(chatId)
    .map((u) => ({ ...publicUserFor(u, viewerId), role: u.role }));
}

function serializeMessage(row) {
  if (!row) return null;
  const reactions = db
    .prepare('SELECT user_id, emoji FROM reactions WHERE message_id = ?')
    .all(row.id);
  const readers = db
    .prepare("SELECT user_id FROM receipts WHERE message_id = ? AND status = 'read'")
    .all(row.id)
    .map((r) => r.user_id);
  const delivered = db
    .prepare('SELECT user_id FROM receipts WHERE message_id = ?')
    .all(row.id)
    .map((r) => r.user_id);
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    type: row.type,
    body: row.deleted ? null : row.body,
    mediaUrl: row.deleted ? null : row.media_url,
    mediaName: row.deleted ? null : row.media_name,
    mediaMime: row.deleted ? null : row.media_mime,
    replyTo: row.reply_to,
    encrypted: Boolean(row.encrypted),
    forwarded: Boolean(row.forwarded),
    expiresAt: row.expires_at || null,
    mentions: row.mentions ? JSON.parse(row.mentions) : [],
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: Boolean(row.deleted),
    reactions,
    readBy: readers,
    deliveredTo: delivered,
  };
}

// Builds the per-user chat summary used in the sidebar.
function getChatSummary(chatId, userId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return null;
  const membership = db
    .prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId);
  if (!membership) return null;

  const members = getMembers(chatId, userId);
  let title = chat.name;
  let avatarUrl = chat.avatar_url;
  let otherUser = null;
  if (chat.type === 'direct') {
    otherUser = members.find((m) => m.id !== userId) || members[0];
    title = otherUser ? otherUser.displayName : 'Conversa';
    avatarUrl = otherUser ? otherUser.avatarUrl : null;
  }

  // Hide messages a blocked contact sent after I blocked them (from preview too).
  const blockHide = `NOT EXISTS (SELECT 1 FROM blocks b
       WHERE b.blocker_id = ? AND b.blocked_id = m.sender_id AND m.created_at >= b.created_at)`;

  const lastRow = db
    .prepare(`SELECT m.* FROM messages m WHERE m.chat_id = ? AND ${blockHide}
              ORDER BY m.created_at DESC LIMIT 1`)
    .get(chatId, userId);

  const unread = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m
       WHERE m.chat_id = ? AND m.sender_id != ? AND m.created_at > ? AND ${blockHide}`
    )
    .get(chatId, userId, membership.last_read_at, userId).c;

  const blocked = chat.type === 'direct' && otherUser ? iBlocked(userId, otherUser.id) : false;

  let pinnedMessage = null;
  if (chat.pinned_message_id) {
    const pm = db.prepare('SELECT * FROM messages WHERE id = ?').get(chat.pinned_message_id);
    if (pm && !pm.deleted) pinnedMessage = serializeMessage(pm);
  }

  return {
    id: chat.id,
    type: chat.type,
    title,
    avatarUrl,
    members,
    otherUser,
    createdBy: chat.created_by,
    blocked,
    pinnedMessage,
    lastMessage: serializeMessage(lastRow),
    unread,
    lastReadAt: membership.last_read_at,
    archived: Boolean(membership.archived),
    pinned: Boolean(membership.pinned),
    mutedUntil: membership.muted_until || 0,
    muted: (membership.muted_until || 0) > Date.now(),
    disappearingTimer: chat.disappearing_timer || 0,
  };
}

function listChatsForUser(userId) {
  const ids = db
    .prepare('SELECT chat_id FROM chat_members WHERE user_id = ?')
    .all(userId)
    .map((r) => r.chat_id);
  const summaries = ids
    .map((cid) => getChatSummary(cid, userId))
    .filter(Boolean)
    .sort((a, b) => {
      // Pinned chats float to the top; otherwise most-recent first.
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const at = a.lastMessage ? a.lastMessage.createdAt : 0;
      const bt = b.lastMessage ? b.lastMessage.createdAt : 0;
      return bt - at;
    });
  return summaries;
}

// Find an existing 1:1 chat between two users, or create one.
function findOrCreateDirectChat(userA, userB) {
  const existing = db
    .prepare(
      `SELECT c.id FROM chats c
       JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
       JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
       WHERE c.type = 'direct' LIMIT 1`
    )
    .get(userA, userB);
  if (existing) return existing.id;

  const chatId = id();
  const ts = now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO chats (id, type, created_by, created_at) VALUES (?, ?, ?, ?)').run(
      chatId,
      'direct',
      userA,
      ts
    );
    const ins = db.prepare(
      'INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    );
    ins.run(chatId, userA, 'member', ts);
    ins.run(chatId, userB, 'member', ts);
  });
  tx();
  return chatId;
}

module.exports = {
  isMember,
  getMemberIds,
  getMembers,
  serializeMessage,
  getChatSummary,
  listChatsForUser,
  findOrCreateDirectChat,
  iBlocked,
  blockRow,
  isBlockedEither,
  contactsOf,
  canAddToGroup,
  sharesChat,
  publicUserFor,
};
