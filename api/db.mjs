import pg from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn("WARNING: DATABASE_URL environment variable is not defined!");
}

export const pool = new pg.Pool({
  connectionString,
  ssl: connectionString && !connectionString.includes('localhost') && !connectionString.includes('127.0.0.1')
    ? { rejectUnauthorized: false }
    : false,
  max: 10, // Limit connections in serverless environment
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

// SQLite to PostgreSQL query translator
function translateSql(sql) {
  let index = 1;
  // Convert SQLite placeholders (?) to PostgreSQL ($1, $2, etc.)
  let translated = sql.replace(/\?/g, () => `$${index++}`);
  
  // Handlers for specific SQLite keywords and features
  if (/DELETE FROM sqlite_sequence/i.test(translated)) {
    // Reset all sequences in PostgreSQL to start from 1
    return `
      SELECT pg_catalog.setval(c.oid, 1, false)
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname = 'public';
    `;
  }

  // Map common SQLite functions or clauses if they differ
  // SQLite: GLOB (not used here, but good practice). LIKE is case-insensitive in SQLite by default.
  // In our case, we can keep it as LIKE, but if needed, we can replace it with ILIKE. 
  // Let's keep LIKE since it works fine for standard matches.

  // Automatically append RETURNING id to INSERT statements to populate lastInsertRowid
  // Exclude inventory_balances table because it doesn't have an 'id' column
  if (/^\s*insert\s+/i.test(translated) && !/returning/i.test(translated) && !/into\s+inventory_balances/i.test(translated)) {
    translated += " RETURNING id";
  }
  
  return translated;
}

class Statement {
  constructor(client, sql) {
    this.client = client;
    this.sql = translateSql(sql);
    this.isMock = /PRAGMA/i.test(sql) || /CREATE TABLE/i.test(sql) || /DROP TABLE/i.test(sql);
  }

  async run(...args) {
    if (this.isMock) {
      return { changes: 0, lastInsertRowid: null };
    }
    // Flatten array arguments if nested arrays are passed
    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    const res = await this.client.query(this.sql, flatArgs);
    return {
      changes: res.rowCount,
      lastInsertRowid: res.rows[0]?.id || null
    };
  }

  async get(...args) {
    if (this.isMock) {
      return null;
    }
    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    const res = await this.client.query(this.sql, flatArgs);
    return res.rows[0] || null;
  }

  async all(...args) {
    if (this.isMock) {
      return [];
    }
    const flatArgs = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    const res = await this.client.query(this.sql, flatArgs);
    return res.rows;
  }
}

class RequestDb {
  constructor(client) {
    this.client = client;
  }

  async exec(sql) {
    // Intercept SQLite PRAGMA or DDL table creation and ignore them gracefully on Supabase
    if (/PRAGMA/i.test(sql) || /CREATE TABLE/i.test(sql) || /DROP TABLE/i.test(sql)) {
      // These are handled by executing schema.sql directly in the Supabase console.
      return;
    }
    await this.client.query(sql);
  }

  prepare(sql) {
    return new Statement(this.client, sql);
  }
}

export async function getDbClient() {
  const client = await pool.connect();
  const db = new RequestDb(client);
  return {
    db,
    release: () => client.release()
  };
}
