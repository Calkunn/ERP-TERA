import pg from 'pg';
import { DatabaseSync } from 'node:sqlite';

const connectionString = process.env.DATABASE_URL;

let sqliteDbInstance = null;
function getSqliteDb() {
  if (!sqliteDbInstance) {
    sqliteDbInstance = new DatabaseSync("data/erp.sqlite");
    sqliteDbInstance.exec("PRAGMA foreign_keys = ON");
  }
  return sqliteDbInstance;
}

export const pool = connectionString ? new pg.Pool({
  connectionString,
  ssl: connectionString && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
}) : null;

// SQLite to PostgreSQL query translator
function translateSql(sql) {
  let index = 1;
  let translated = sql.replace(/\?/g, () => `$${index++}`);
  
  if (/DELETE FROM sqlite_sequence/i.test(translated)) {
    return `
      SELECT pg_catalog.setval(c.oid, 1, false)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname = 'public';
    `;
  }

  if (/^\s*insert\s+/i.test(translated) && !/returning/i.test(translated) && !/into\s+inventory_balances/i.test(translated)) {
    translated += " RETURNING id";
  }
  
  return translated;
}

class Statement {
  constructor(client, sql, isSqlite = false) {
    this.client = client;
    this.originalSql = sql;
    this.isSqlite = isSqlite;
    this.sql = isSqlite ? sql : translateSql(sql);
    this.isMock = !isSqlite && (/PRAGMA/i.test(sql) || (/CREATE TABLE/i.test(sql) && !/auxiliary_balances/i.test(sql)) || /DROP TABLE/i.test(sql));
  }

  async run(...args) {
    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (this.isSqlite) {
      const stmt = this.client.prepare(this.sql);
      const res = stmt.run(...flatArgs);
      return {
        changes: res.changes,
        lastInsertRowid: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null
      };
    } else {
      if (this.isMock) {
        return { changes: 0, lastInsertRowid: null };
      }
      const res = await this.client.query(this.sql, flatArgs);
      return {
        changes: res.rowCount,
        lastInsertRowid: res.rows[0]?.id || null
      };
    }
  }

  async get(...args) {
    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (this.isSqlite) {
      const stmt = this.client.prepare(this.sql);
      return stmt.get(...flatArgs) || null;
    } else {
      if (this.isMock) {
        return null;
      }
      const res = await this.client.query(this.sql, flatArgs);
      return res.rows[0] || null;
    }
  }

  async all(...args) {
    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    if (this.isSqlite) {
      const stmt = this.client.prepare(this.sql);
      return stmt.all(...flatArgs);
    } else {
      if (this.isMock) {
        return [];
      }
      const res = await this.client.query(this.sql, flatArgs);
      return res.rows;
    }
  }
}

class RequestDb {
  constructor(client, isSqlite = false) {
    this.client = client;
    this.isSqlite = isSqlite;
  }

  async exec(sql) {
    if (this.isSqlite) {
      this.client.exec(sql);
    } else {
      if (/PRAGMA/i.test(sql) || (/CREATE TABLE/i.test(sql) && !/auxiliary_balances/i.test(sql)) || /DROP TABLE/i.test(sql)) {
        return;
      }
      await this.client.query(sql);
    }
  }

  prepare(sql) {
    return new Statement(this.client, sql, this.isSqlite);
  }
}

export async function getDbClient() {
  if (connectionString) {
    const client = await pool.connect();
    const db = new RequestDb(client, false);
    return {
      db,
      release: () => client.release()
    };
  } else {
    const client = getSqliteDb();
    const db = new RequestDb(client, true);
    return {
      db,
      release: () => {}
    };
  }
}
