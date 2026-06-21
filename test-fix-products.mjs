import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/erp.sqlite");
db.exec("PRAGMA foreign_keys = ON");

console.log("=== Testing different SUM approaches ===\n");

// Broken: SUM returns NULL which might cause GROUP BY issues
const test1 = db.prepare(`
  SELECT v.id, p.name, SUM(ib.qty) as total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  WHERE p.status != 'Archived'
  GROUP BY v.id
`).all();
console.log("Test 1 (SUM without COALESCE):", test1.length, test1.slice(0, 1));

// Try with COALESCE on the SUM itself
const test2 = db.prepare(`
  SELECT v.id, p.name, COALESCE(SUM(ib.qty), 0) as total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  WHERE p.status != 'Archived'
  GROUP BY v.id
`).all();
console.log("Test 2 (COALESCE on SUM):", test2.length, test2.slice(0, 1));

// Try with IFNULL instead
const test3 = db.prepare(`
  SELECT v.id, p.name, IFNULL(SUM(ib.qty), 0) as total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  WHERE p.status != 'Archived'
  GROUP BY v.id, p.name
`).all();
console.log("Test 3 (GROUP BY with names):", test3.length, test3.slice(0, 1));

// Try selecting all columns properly
const test4 = db.prepare(`
  SELECT v.id AS variant_id, p.id AS product_id, p.name, p.category, p.status, v.sku,
    COALESCE(SUM(ib.qty), 0) as total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  WHERE p.status != 'Archived'
  GROUP BY v.id, p.id, p.name, p.category, p.status, v.sku
`).all();
console.log("Test 4 (All GROUP BY columns):", test4.length, test4.slice(0, 1));

// The original broken query structure
const test5 = db.prepare(`
  SELECT v.id AS variant_id, p.id AS product_id, p.name, p.category, p.status, v.sku, v.size, v.color,
    v.cost_price, v.sell_price, v.low_stock,
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
console.log("Test 5 (Original query):", test5.length);

// Fix: Group by all non-aggregate columns
const test6 = db.prepare(`
  SELECT v.id AS variant_id, p.id AS product_id, p.name, p.category, p.status, v.sku, v.size, v.color,
    v.cost_price, v.sell_price, v.low_stock,
    COALESCE(SUM(CASE WHEN ip.name = 'Online Inventory' THEN ib.qty END), 0) AS online_qty,
    COALESCE(SUM(CASE WHEN ip.name = 'Offline Inventory' THEN ib.qty END), 0) AS offline_qty,
    COALESCE(SUM(ib.qty), 0) AS total_qty
  FROM variants v
  JOIN products p ON p.id = v.product_id
  LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
  LEFT JOIN inventory_pools ip ON ip.id = ib.pool_id
  WHERE p.status != 'Archived'
  GROUP BY v.id, p.id, p.name, p.category, p.status, v.sku, v.size, v.color, v.cost_price, v.sell_price, v.low_stock
  ORDER BY p.name, v.sku
`).all();
console.log("Test 6 (Fixed with full GROUP BY):", test6.length, test6.slice(0, 1));

db.close();
