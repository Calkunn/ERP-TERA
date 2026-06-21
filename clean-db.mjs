import Database from 'better-sqlite3';

const db = new Database('data/erp.sqlite');

// Disable foreign key constraints temporarily to allow deletion in any order
db.pragma('foreign_keys = OFF');

const tables = [
  'sales_order_items',
  'sales_orders',
  'purchase_order_items',
  'purchase_orders',
  'stock_transfers',
  'stock_movements',
  'inventory_balances',
  'monthly_revenue_items',
  'monthly_revenues',
  'monthly_expenses',
  'variants',
  'products',
  'customers',
  'suppliers',
  'inventory_pools',
  'users'
];

console.log('Deleting all data from tables...');
tables.forEach(table => {
  db.prepare(`DELETE FROM ${table}`).run();
  console.log(`  ✓ Cleared ${table}`);
});

// Reset auto-increment sequences
db.prepare("DELETE FROM sqlite_sequence").run();
console.log('  ✓ Reset auto-increment sequences');

// Re-enable foreign key constraints
db.pragma('foreign_keys = ON');

console.log('\n✅ Database cleaned successfully!');
db.close();
