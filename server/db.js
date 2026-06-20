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
  last_seen    INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,         -- 'direct' | 'group'
  name        TEXT,                  -- group name (null for direct)
  avatar_url  TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  joined_at INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
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
`);

module.exports = db;
