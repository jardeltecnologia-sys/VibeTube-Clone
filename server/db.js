'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const { createPostgresDb } = require('./pg-sync-db');

const engine = (config.db.engine || '').toUpperCase();
const usePostgres = engine === 'POSTGRES' || (engine !== 'SQLITE' && Boolean(config.db.url));

if (!usePostgres && !fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

const db = usePostgres
  ? createPostgresDb({ connectionString: config.db.url, max: config.db.poolMax })
  : new Database(path.join(config.dataDir, 'speedvox.db'));

if (!usePostgres) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

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
  virtual_number TEXT UNIQUE,
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

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS starred (
  user_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contacts (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  user_id      TEXT,                 -- linked SpeedVox user, if this contact is one
  display_name TEXT NOT NULL,
  phone        TEXT,
  email        TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id, display_name);

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, option_index),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- VibeTube Mesh / SpeedVox Offline Mode (additive). Offline devices register a
-- public identity and, when back online, sync the offline messages they relayed.
CREATE TABLE IF NOT EXISTS mesh_devices (
  device_id    TEXT PRIMARY KEY,       -- derived from the signing public key
  public_key   TEXT NOT NULL,          -- shareable public bundle (JSON: signPub, kxPub)
  display_name TEXT,
  user_id      TEXT,                   -- optional link to a SpeedVox account
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mesh_messages (
  message_id     TEXT PRIMARY KEY,     -- envelope messageId (dedup key)
  type           TEXT NOT NULL,
  from_device_id TEXT,
  to_device_id   TEXT,
  room_id        TEXT,
  envelope       TEXT NOT NULL,        -- full signed envelope (JSON)
  created_at     INTEGER NOT NULL,     -- envelope createdAt
  received_at    INTEGER NOT NULL,     -- when the server accepted it
  expires_at     INTEGER               -- retention cutoff
);
CREATE INDEX IF NOT EXISTS idx_mesh_messages_received ON mesh_messages(received_at);
CREATE INDEX IF NOT EXISTS idx_mesh_messages_room ON mesh_messages(room_id, received_at);

CREATE TABLE IF NOT EXISTS audio_transcriptions (
  message_id TEXT PRIMARY KEY,
  transcript TEXT NOT NULL,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_tasks (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  message_id  TEXT,
  title       TEXT NOT NULL,
  assignee_id TEXT,
  due_date    INTEGER,
  completed   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_tasks_chat ON chat_tasks(chat_id);
`);

// Migrations for databases created before these columns existed.
function ensureColumn(table, column, ddl) {
  if (db.isPostgres) {
    if (!db.columnExists(table, column)) db.addColumn(table, ddl);
    return;
  }
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('users', 'public_key', 'public_key TEXT');
// Existing accounts default to verified (1) so the new flow never locks them out.
ensureColumn('users', 'email_verified', 'email_verified INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'privacy_last_seen', "privacy_last_seen TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('users', 'read_receipts', 'read_receipts INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'privacy_groups', "privacy_groups TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('users', 'privacy_photo', "privacy_photo TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('users', 'privacy_about', "privacy_about TEXT NOT NULL DEFAULT 'everyone'");
ensureColumn('messages', 'encrypted', 'encrypted INTEGER NOT NULL DEFAULT 0');
ensureColumn('messages', 'forwarded', 'forwarded INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_members', 'archived', 'archived INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_members', 'pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
ensureColumn('chat_members', 'muted_until', 'muted_until INTEGER NOT NULL DEFAULT 0');
ensureColumn('chats', 'disappearing_timer', 'disappearing_timer INTEGER NOT NULL DEFAULT 0');
ensureColumn('chats', 'pinned_message_id', 'pinned_message_id TEXT');
ensureColumn('messages', 'expires_at', 'expires_at INTEGER');
ensureColumn('messages', 'mentions', 'mentions TEXT');
// Scheduled messages: when set and in the future, the message is held back
// (invisible) until the sweeper delivers it.
ensureColumn('messages', 'send_at', 'send_at INTEGER');
ensureColumn('users', 'virtual_number', 'virtual_number TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_virtual_number ON users(virtual_number)');
ensureColumn('messages', 'ghost_ttl', 'ghost_ttl INTEGER');

module.exports = db;
