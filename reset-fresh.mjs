import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/erp.sqlite");

// Get all tables
const tables = db.prepare(`
  SELECT name FROM sqlite_master 
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
`).all();

console.log("Clearing all tables...");

// Delete all data from all tables
for (const table of tables) {
  const tableName = table.name;
  try {
    // Disable foreign keys temporarily
    db.exec("PRAGMA foreign_keys = OFF");
    
    // Delete all rows
    db.prepare(`DELETE FROM ${tableName}`).run();
    
    // Reset auto-increment sequences
    db.prepare(`DELETE FROM sqlite_sequence WHERE name='${tableName}'`).run();
    
    console.log(`✓ Cleared ${tableName}`);
  } catch (err) {
    console.log(`⚠ ${tableName}: ${err.message}`);
  }
}

// Re-enable foreign keys
db.exec("PRAGMA foreign_keys = ON");

// Verify tables are empty
console.log("\n✓ Database reset successfully!");
console.log("\nTable status:");
for (const table of tables) {
  const count = db.prepare(`SELECT COUNT(*) as cnt FROM ${table.name}`).get().cnt;
  console.log(`  ${table.name}: ${count} rows`);
}

console.log("\n✓ Ready to set up fresh data from UI");
