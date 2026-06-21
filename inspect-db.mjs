import Database from 'better-sqlite3';

const db = new Database('data/erp.sqlite');

// Get all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

console.log('Tables in erp.sqlite:');
tables.forEach(t => console.log('  - ' + t.name));

// Get table schemas
tables.forEach(t => {
  const info = db.prepare('PRAGMA table_info(' + t.name + ')').all();
  console.log('\n' + t.name + ' columns:');
  info.forEach(col => console.log('  - ' + col.name + ' (' + col.type + ')' + (col.pk ? ' [PRIMARY KEY]' : '') + (col.notnull ? ' NOT NULL' : '')));
  
  // Show row count
  const count = db.prepare('SELECT COUNT(*) as cnt FROM ' + t.name).get();
  console.log('  Rows: ' + count.cnt);
});

db.close();
