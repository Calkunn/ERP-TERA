import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/erp.sqlite");
db.exec("PRAGMA foreign_keys = ON");

// Test the exact products query from server.mjs
const result = db.prepare(`
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
  ORDER BY p.name, v.sku
`).all();

console.log("Products query result:");
console.log(JSON.stringify(result, null, 2));
console.log("\nTotal rows:", result.length);

db.close();
