import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/erp.sqlite");
db.exec("PRAGMA foreign_keys = ON");

console.log("=== Testing product queries step by step ===\n");

// Test 1: Count products
const productCount = db.prepare("SELECT COUNT(*) as cnt FROM products").get();
console.log("1. Total products:", productCount);

// Test 2: Count variants
const variantCount = db.prepare("SELECT COUNT(*) as cnt FROM variants").get();
console.log("2. Total variants:", variantCount);

// Test 3: Simple join
const simpleJoin = db.prepare("SELECT v.id, p.name FROM variants v JOIN products p ON p.id = v.product_id").all();
console.log("3. Simple join result count:", simpleJoin.length);
console.log("   Sample:", simpleJoin.slice(0, 2));

// Test 4: With LEFT JOIN for inventory_balances
const withInventory = db.prepare(`
  SELECT v.id, p.name, ib.qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
`).all();
console.log("4. With inventory_balances LEFT JOIN count:", withInventory.length);
console.log("   Sample:", withInventory.slice(0, 2));

// Test 5: With GROUP BY (the issue might be here)
const withGroupBy = db.prepare(`
  SELECT v.id, p.name
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  GROUP BY v.id
`).all();
console.log("5. With GROUP BY count:", withGroupBy.length);
console.log("   Sample:", withGroupBy.slice(0, 2));

// Test 6: Full query but without pool join first
const noPoolJoin = db.prepare(`
  SELECT v.id, p.name, SUM(ib.qty) as total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  WHERE p.status != 'Archived'
  GROUP BY v.id
`).all();
console.log("6. Without pool join count:", noPoolJoin.length);
console.log("   Sample:", noPoolJoin.slice(0, 2));

// Test 7: Full query with all JOINs
const fullQuery = db.prepare(`
  SELECT v.id, p.name,
    COALESCE(SUM(CASE WHEN ip.name = 'Online Inventory' THEN ib.qty END), 0) AS online_qty,
    COALESCE(SUM(CASE WHEN ip.name = 'Offline Inventory' THEN ib.qty END), 0) AS offline_qty,
    COALESCE(SUM(ib.qty), 0) AS total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  LEFT JOIN inventory_pools ip ON ip.id = ib.pool_id
  WHERE p.status != 'Archived'
  GROUP BY v.id
`).all();
console.log("7. Full query with all JOINs count:", fullQuery.length);
if (fullQuery.length > 0) {
  console.log("   Sample:", fullQuery.slice(0, 2));
} else {
  console.log("   RESULT IS EMPTY - THIS IS THE BUG!");
}

db.close();
