'use strict';

const deasync = require('deasync');
const { Pool, types } = require('pg');

// Keep integer columns as numbers instead of pg's default string for int8.
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(21, (value) => Number(value));
types.setTypeParser(23, (value) => Number(value));

function waitCallback(start) {
  let done = false;
  let result;
  let error;
  start((err, value) => {
    if (err) {
      error = err;
    } else {
      result = value;
    }
    done = true;
  });
  deasync.loopWhile(() => !done);
  if (error) throw error;
  return result;
}

function translatePlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeSql(sql) {
  let out = String(sql).trim();
  if (!out) return out;

  if (/^PRAGMA\b/i.test(out)) return '';

  const insertIgnore = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out);
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
  out = out.replace(/\s+COLLATE\s+NOCASE\b/ig, '');
  out = out.replace(/\bINTEGER\b/ig, 'BIGINT');
  out = translatePlaceholders(out);

  if (insertIgnore && !/\sON\s+CONFLICT\s/i.test(out)) {
    out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }

  return out;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

class PostgresStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  get(...params) {
    const result = this.db.query(this.sql, params);
    return result.rows[0];
  }

  all(...params) {
    return this.db.query(this.sql, params).rows;
  }

  run(...params) {
    const result = this.db.query(this.sql, params);
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: undefined,
    };
  }
}

class PostgresSyncDb {
  constructor(options) {
    this.isPostgres = true;
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    this.txClient = null;
  }

  prepare(sql) {
    return new PostgresStatement(this, sql);
  }

  query(sql, params = []) {
    const normalized = normalizeSql(sql);
    if (!normalized) return { rows: [], rowCount: 0 };
    const client = this.txClient || this.pool;
    return waitCallback((done) => client.query(normalized, params, done));
  }

  exec(sql) {
    const normalized = normalizeSql(sql);
    if (!normalized) return;
    this.query(normalized);
  }

  pragma() {
    return undefined;
  }

  transaction(fn) {
    return (...args) => {
      if (this.txClient) return fn(...args);
      const client = waitCallback((done) => this.pool.connect(done));
      this.txClient = client;
      try {
        waitCallback((done) => client.query('BEGIN', done));
        const result = fn(...args);
        waitCallback((done) => client.query('COMMIT', done));
        return result;
      } catch (err) {
        try {
          waitCallback((done) => client.query('ROLLBACK', done));
        } catch (_) {}
        throw err;
      } finally {
        this.txClient = null;
        client.release();
      }
    };
  }

  columnExists(table, column) {
    const result = this.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ?
          AND column_name = ?
        LIMIT 1`,
      [table, column]
    );
    return result.rows.length > 0;
  }

  addColumn(table, ddl) {
    this.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${ddl}`);
  }

  close() {
    waitCallback((done) => this.pool.end(done));
  }
}

function createPostgresDb(options) {
  if (!options.connectionString) {
    throw new Error('DB_ENGINE=POSTGRES requires DATABASE_URL');
  }
  return new PostgresSyncDb(options);
}

module.exports = { createPostgresDb, normalizeSql };
