'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

// Loading these modules creates the PostgreSQL schema using the same startup
// path as production, including auxiliary tables owned by push/FCM/auth flows.
const config = require('../server/config');
const appDb = require('../server/db');
require('../server/push');
require('../server/fcm');
require('../server/routes/auth');

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function tableExists(client, table) {
  return client
    .query("SELECT to_regclass($1) AS name", [`public.${table}`])
    .then((result) => Boolean(result.rows[0] && result.rows[0].name));
}

async function main() {
  if (config.db.engine !== 'POSTGRES') {
    throw new Error('Set DB_ENGINE=POSTGRES and DATABASE_URL before running this migration');
  }

  const sqlitePath = process.argv[2] || path.join(config.dataDir, 'speedvox.db');
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found: ${sqlitePath}`);

  const sqlite = new Database(sqlitePath, { readonly: true });
  const client = new Client({ connectionString: config.db.url });
  await client.connect();

  const sqliteTables = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name`
    )
    .all()
    .map((row) => row.name);

  const preferredOrder = [
    'users',
    'chats',
    'chat_members',
    'messages',
    'receipts',
    'reactions',
    'blocks',
    'statuses',
    'status_views',
    'link_requests',
    'email_verification_tokens',
    'password_reset_tokens',
    'starred',
    'contacts',
    'poll_votes',
    'mesh_devices',
    'mesh_messages',
    'audio_transcriptions',
    'chat_tasks',
    'push_subscriptions',
    'fcm_tokens',
  ];
  const ordered = [
    ...preferredOrder.filter((table) => sqliteTables.includes(table)),
    ...sqliteTables.filter((table) => !preferredOrder.includes(table)),
  ];

  try {
    for (const table of ordered) {
      if (!(await tableExists(client, table))) {
        console.warn(`Skipping ${table}: target table does not exist`);
        continue;
      }

      const columns = sqlite.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map((col) => col.name);
      if (!columns.length) continue;

      const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
      if (!rows.length) {
        console.log(`${table}: 0 rows`);
        continue;
      }

      const columnSql = columns.map(quoteIdent).join(', ');
      const paramSql = columns.map((_, index) => `$${index + 1}`).join(', ');
      const insertSql = `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES (${paramSql}) ON CONFLICT DO NOTHING`;

      await client.query('BEGIN');
      try {
        for (const row of rows) {
          await client.query(insertSql, columns.map((column) => (row[column] === undefined ? null : row[column])));
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      console.log(`${table}: ${rows.length} rows`);
    }
  } finally {
    sqlite.close();
    await client.end();
    if (appDb && typeof appDb.close === 'function') appDb.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
