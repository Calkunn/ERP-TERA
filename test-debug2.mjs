import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/erp.sqlite");
db.exec("PRAGMA foreign_keys = ON");

console.log("=== Debugging inventory data ===\n");

// Check if inventory_balances has the expected data
const balances = db.prepare("SELECT * FROM inventory_balances LIMIT 5").all();
console.log("Sample inventory_balances:");
console.log(JSON.stringify(balances, null, 2));

// Check inventory_pools
const pools = db.prepare("SELECT * FROM inventory_pools").all();
console.log("\nInventory pools:");
console.log(JSON.stringify(pools, null, 2));

// Try a simpler LEFT JOIN test
const simpleTest = db.prepare(`
  SELECT v.id, COUNT(ib.variant_id) as ib_count
  FROM variants v
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  GROUP BY v.id
`).all();
console.log("\nVariants with inventory_balance counts:");
console.log(JSON.stringify(simpleTest, null, 2));

// Test with pool join
const withPool = db.prepare(`
  SELECT v.id, ib.qty, ip.name
  FROM variants v
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  LEFT JOIN inventory_pools ip ON ip.id = ib.pool_id
  LIMIT 10
`).all();
console.log("\nVariants with pool names:");
console.log(JSON.stringify(withPool, null, 2));

// Now test if the issue is with the WHERE clause or the status column
const checkStatus = db.prepare("SELECT DISTINCT status FROM products").all();
console.log("\nProduct statuses:");
console.log(JSON.stringify(checkStatus, null, 2));

// Test without WHERE clause
const noWhere = db.prepare(`
  SELECT v.id, p.name
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  GROUP BY v.id
`).all();
console.log("\nNo WHERE clause result count:", noWhere.length);

// Test with DISTINCT instead of GROUP BY
const withDistinct = db.prepare(`
  SELECT DISTINCT v.id, p.name
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  LEFT JOIN inventory_pools ip ON ip.id = ib.pool_id
  WHERE p.status != 'Archived'
`).all();
console.log("With DISTINCT count:", withDistinct.length);
console.log(JSON.stringify(withDistinct.slice(0, 2), null, 2));

db.close();
