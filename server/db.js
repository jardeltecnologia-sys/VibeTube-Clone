'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, 'speedvox.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  email        TEXT UNIQUE,
  password     TEXT,                 -- bcrypt hash, null for OAuth-only accounts
  google_id    TEXT UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  about        TEXT DEFAULT 'Disponível',
  public_key   TEXT,                 -- ECDH public key (JWK) for end-to-end encryption
  last_seen    INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,         -- 'direct' | 'group'
  name        TEXT,                  -- group name (null for direct)
  avatar_url  TEXT,
  created_by  TEXT,
  disappearing_timer INTEGER NOT NULL DEFAULT 0,  -- seconds; 0 = off
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  joined_at INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  sender_id   TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'image' | 'file' | 'system'
  body        TEXT,
  media_url   TEXT,
  media_name  TEXT,
  media_mime  TEXT,
  reply_to    TEXT,
  encrypted   INTEGER NOT NULL DEFAULT 0,  -- 1 = body holds an E2EE ciphertext envelope
  forwarded   INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                      -- disappearing messages: delete after this time
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  status     TEXT NOT NULL,          -- 'delivered' | 'read'
  at         INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS statuses (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'text',  -- 'text' | 'image'
  body       TEXT,                          -- text content or image caption
  media_url  TEXT,
  bg_color   TEXT,                          -- background color for text statuses
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,              -- created_at + 24h
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS status_views (
  status_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  viewed_at INTEGER NOT NULL,
  PRIMARY KEY (status_id, viewer_id),
  FOREIGN KEY (status_id) REFERENCES statuses(id) ON DELETE CASCADE,
  FOREIGN KEY (viewer_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_statuses_user ON statuses(user_id, expires_at);

CREATE TABLE IF NOT EXISTS link_requests (
  code       TEXT PRIMARY KEY,
  token      TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS starred (
  user_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
`);

// Migrations for databases created before these columns existed.
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'public_key', 'public_key TEXT');
ensureColumn('users', 'privacy_last_seen', "privacy_last_seen TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('users', 'read_receipts', 'read_receipts INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'privacy_groups', "privacy_groups TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('messages', 'encrypted', 'encrypted INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'forwarded', 'forwarded INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_members', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_members', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_members', 'muted_until', 'muted_until INTEGER NOT NULL DEFAULT 0');
ensureColumn('chats', 'disappearing_timer', 'disappearing_timer INTEGER NOT NULL DEFAULT 0');
ensureColumn('chats', 'pinned_message_id', 'pinned_message_id TEXT');
ensureColumn('messages', 'expires_at', 'expires_at INTEGER');
ensureColumn('messages', 'mentions', 'mentions TEXT');

module.exports = db;
