import { createHash, randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getDbClient } from "./db.mjs";
import { AsyncLocalStorage } from "node:async_hooks";

const root = process.cwd();
const sessions = new Map();
const dbStorage = new AsyncLocalStorage();

const db = {
  prepare(sql) {
    const store = dbStorage.getStore();
    if (!store) throw new Error("Database client not available outside request context!");
    return store.db.prepare(sql);
  },
  async exec(sql) {
    const store = dbStorage.getStore();
    if (!store) throw new Error("Database client not available outside request context!");
    return await store.db.exec(sql);
  }
};

function hashPassword(password) {
  return createHash("sha256").update(String(password)).digest("hex");
}

async function initDb() {
  // Check if purchase_order_items needs migration from variant_id to material_name
  let dropPoItems = false;
  try {
    const info = await db.prepare("PRAGMA table_info(purchase_order_items)").all();
    if (info.length > 0 && info.some(col => col.name === "variant_id")) {
      dropPoItems = true;
    }
  } catch (e) {
    // Table doesn't exist yet
  }
  if (dropPoItems) {
    console.log("Migration: Dropping old purchase_order_items table...");
    try {
      await db.exec("DROP TABLE purchase_order_items");
      console.log("✓ Dropped old purchase_order_items table.");
    } catch (err) {
      console.error("Failed to drop old purchase_order_items table:", err);
    }
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('Owner', 'Admin')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Aktif'
    );
    CREATE TABLE IF NOT EXISTS variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      size TEXT NOT NULL,
      color TEXT NOT NULL,
      cost_price INTEGER NOT NULL,
      sell_price INTEGER NOT NULL,
      low_stock INTEGER NOT NULL DEFAULT 5,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS inventory_pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS inventory_balances (
      variant_id INTEGER NOT NULL,
      pool_id INTEGER NOT NULL,
      qty INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (variant_id, pool_id),
      FOREIGN KEY (variant_id) REFERENCES variants(id),
      FOREIGN KEY (pool_id) REFERENCES inventory_pools(id)
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL,
      pool_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      qty INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL,
      from_pool_id INTEGER NOT NULL,
      to_pool_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Selesai',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS monthly_revenues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL UNIQUE,
      online_revenue INTEGER NOT NULL DEFAULT 0,
      offline_revenue INTEGER NOT NULL DEFAULT 0,
      online_notes TEXT,
      offline_notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS monthly_revenue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monthly_revenue_id INTEGER NOT NULL,
      variant_id INTEGER NOT NULL,
      online_qty INTEGER NOT NULL DEFAULT 0,
      offline_qty INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (monthly_revenue_id) REFERENCES monthly_revenues(id) ON DELETE CASCADE,
      FOREIGN KEY (variant_id) REFERENCES variants(id)
    );
    CREATE TABLE IF NOT EXISTS monthly_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      channel TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      revenue_stream TEXT NOT NULL,
      channel TEXT NOT NULL,
      customer_id INTEGER,
      status TEXT NOT NULL DEFAULT 'Selesai',
      discount INTEGER NOT NULL DEFAULT 0,
      shipping_fee INTEGER NOT NULL DEFAULT 0,
      platform_fee INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
    CREATE TABLE IF NOT EXISTS sales_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      variant_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      price INTEGER NOT NULL,
      cost_price INTEGER NOT NULL,
      FOREIGN KEY (order_id) REFERENCES sales_orders(id),
      FOREIGN KEY (variant_id) REFERENCES variants(id)
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT
    );
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_no TEXT NOT NULL UNIQUE,
      supplier_id INTEGER,
      pool_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Diterima',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL,
      material_name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      cost_price INTEGER NOT NULL,
      FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id)
    );
    CREATE TABLE IF NOT EXISTS production_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_no TEXT NOT NULL UNIQUE,
      batch_type TEXT NOT NULL CHECK(batch_type IN ('Sampling', 'Final Production')),
      due_date TEXT NOT NULL,
      cutting_progress INTEGER DEFAULT 0,
      sewing_progress INTEGER DEFAULT 0,
      finishing_progress INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Sedang Diproses',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS production_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      production_cost INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS bill_of_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      material_name TEXT NOT NULL,
      required_qty REAL NOT NULL,
      unit TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  if (dropPoItems) {
    console.log("Migration: Re-seeding purchase orders with raw materials...");
    await db.exec("PRAGMA foreign_keys = OFF");
    try {
      await db.exec("DELETE FROM purchase_order_items");
      await db.exec("DELETE FROM purchase_orders");
      
      const pos = [
        ["PO-2826-888", 1, 1, "Diterima Sebagian", "2026-06-10"],
        ["PO-2826-887", 2, 1, "Selesai", "2026-06-08"],
        ["PO-2826-886", 3, 1, "Selesai", "2026-06-05"],
        ["PO-2826-885", 4, 1, "Dikirim", "2026-06-13"],
        ["PO-2826-884", 1, 1, "Draft", "2026-06-14"]
      ];
      const poStmt = await db.prepare("INSERT INTO purchase_orders (po_no, supplier_id, pool_id, status, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const row of pos) await poStmt.run(...row);

      const poItems = [
        [1, "Heavy Cotton Combed 20s", 15, 950000],
        [1, "Buttons", 200, 4500],
        [2, "Heavy Cotton Combed 20s", 10, 950000],
        [3, "Metal Buttons", 20, 15000],
        [4, "Buttons", 500, 4500],
        [5, "Heavy Cotton Combed 20s", 8, 950000]
      ];
      const poItemStmt = await db.prepare("INSERT INTO purchase_order_items (purchase_order_id, material_name, qty, cost_price) VALUES (?, ?, ?, ?)");
      for (const row of poItems) await poItemStmt.run(...row);
      
      console.log("✓ Successfully migrated purchase_order_items and re-seeded!");
    } catch (err) {
      console.error("Failed to re-seed POs after migration:", err);
    } finally {
      await db.exec("PRAGMA foreign_keys = ON");
    }
  }

  await seedInventoryPools();
  await seedUsers();

  const shouldSeedMock = process.env.SEED_MOCK_DATA === "true";
  if (shouldSeedMock) {
    await seedBaseData();
    await seedMonthlyRevenue();
    await seedMonthlyExpenses();
    await personalizeExistingData();
  }
}

async function seedInventoryPools() {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM inventory_pools").get();
  const poolCount = Number(row ? row.total : 0);
  if (poolCount === 0) {
    await db.prepare("INSERT INTO inventory_pools (name) VALUES (?), (?) ON CONFLICT (name) DO NOTHING").run("Online Inventory", "Offline Inventory");
  }
}

async function seedUsers() {
  await db.prepare("DELETE FROM users").run();
  const stmt = await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING");
  await stmt.run("Owner TERA", "tera.essential@gmail.com", hashPassword("marksukaallen"), "Owner");
}

async function seedBaseData() {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM products").get();
  const count = Number(row ? row.total : 0);
  if (count > 0) return;

  await db.exec("BEGIN");
  try {
    await db.prepare("INSERT INTO suppliers (name, contact) VALUES (?, ?), (?, ?), (?, ?), (?, ?)").run(
      "Tekstil Majalaya", "0812-1000-2000",
      "PT Sablon Nusantara", "0813-9000-3000",
      "Aksesoris Citayam", "0814-4000-4000",
      "Bordir Solo Jaya", "0815-5000-5000"
    );

    const productRows = [
      ["Kain Cotton Combed 30s", "Bahan Baku"],
      ["Zipper YKK 20cm Black", "Aksesoris"],
      ["Kancing Plastik 12mm", "Aksesoris"],
      ["Heavyweight Tee 'Concrete'", "T-Shirt"],
      ["Boxy Hoodie 'Static'", "Hoodie"],
      ["Workwear Jacket 'Asphalt'", "Jacket"],
      ["Cargo Pants 'Block 88'", "Cargo Pants"]
    ];
    const productStmt = await db.prepare("INSERT INTO products (name, category) VALUES (?, ?)");
    for (const row of productRows) await productStmt.run(...row);

    const variantRows = [
      [1, "MAT-KB-30S-BLK", "Roll", "Black", 950000, 0, 2],
      [1, "MAT-KB-30S-WHT", "Roll", "White", 950000, 0, 2],
      [2, "ACC-ZIP-YKK-BLK", "Pcs", "Black", 4500, 0, 20],
      [3, "ACC-BTN-PL-BLK", "Pack", "Black", 15000, 0, 5],
      [4, "URB-TS-001-S", "S", "Black", 75000, 199000, 8],
      [4, "URB-TS-001-M", "M", "White", 75000, 199000, 8],
      [5, "URB-HD-014-M", "M", "Black", 120000, 299000, 12],
      [5, "URB-HD-014-L", "L", "White", 120000, 299000, 12],
      [6, "URB-JK-007-L", "L", "Black", 180000, 399000, 6],
      [7, "URB-CP-022-XL", "XL", "Olive", 110000, 249000, 5]
    ];
    const variantStmt = await db.prepare(`
      INSERT INTO variants (product_id, sku, size, color, cost_price, sell_price, low_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of variantRows) await variantStmt.run(...row);

    const balanceStmt = await db.prepare("INSERT INTO inventory_balances (variant_id, pool_id, qty) VALUES (?, ?, ?)");
    const balances = [
      [1, 1, 10], [1, 2, 0], [2, 1, 250], [2, 2, 0],
      [3, 1, 150], [3, 2, 0], [4, 1, 30], [4, 2, 0],
      [5, 1, 50], [5, 2, 40], [6, 1, 45], [6, 2, 36],
      [7, 1, 69], [7, 2, 33], [8, 1, 38], [8, 2, 58],
      [9, 1, 42], [9, 2, 64], [10, 1, 52], [10, 2, 48]
    ];
    for (const row of balances) await balanceStmt.run(...row);

    const customers = [
      ["Alya Putri", "0812-1111-1111", "Tokopedia"],
      ["Dimas R.", "0812-2222-2222", "Shopee"],
      ["TERA Store Walk-in", "", "Offline"],
      ["Pop Up Senayan", "", "Offline"]
    ];
    const customerStmt = await db.prepare("INSERT INTO customers (name, phone, channel) VALUES (?, ?, ?)");
    for (const row of customers) await customerStmt.run(...row);

    // Seed Purchase Orders (focused on Raw Materials!)
    const pos = [
      ["PO-2826-888", 1, 1, "Diterima Sebagian", "2026-06-10"],
      ["PO-2826-887", 2, 1, "Selesai", "2026-06-08"],
      ["PO-2826-886", 3, 1, "Selesai", "2026-06-05"],
      ["PO-2826-885", 4, 1, "Dikirim", "2026-06-13"],
      ["PO-2826-884", 1, 1, "Draft", "2026-06-14"]
    ];
    const poStmt = await db.prepare("INSERT INTO purchase_orders (po_no, supplier_id, pool_id, status, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const row of pos) await poStmt.run(...row);

    const poItems = [
      [1, "Heavy Cotton Combed 20s", 15, 950000],
      [1, "Buttons", 200, 4500],
      [2, "Heavy Cotton Combed 20s", 10, 950000],
      [3, "Metal Buttons", 20, 15000],
      [4, "Buttons", 500, 4500],
      [5, "Heavy Cotton Combed 20s", 8, 950000]
    ];
    const poItemStmt = await db.prepare("INSERT INTO purchase_order_items (purchase_order_id, material_name, qty, cost_price) VALUES (?, ?, ?, ?)");
    for (const row of poItems) await poItemStmt.run(...row);

    // Seed Production Batches
    const batches = [
      ["BCH-260", "Final Production", "2026-06-22", 100, 75, 40, "Sedang Diproses"],
      ["BCH-259", "Final Production", "2026-06-25", 100, 60, 0, "Sedang Diproses"],
      ["BCH-258", "Final Production", "2026-06-18", 100, 100, 85, "Sedang Diproses"],
      ["BCH-257", "Final Production", "2026-06-14", 100, 100, 100, "Selesai"],
      ["BCH-256", "Sampling", "2026-06-28", 50, 0, 0, "Sedang Diproses"]
    ];
    const batchStmt = await db.prepare(`
      INSERT INTO production_batches 
      (batch_no, batch_type, due_date, cutting_progress, sewing_progress, finishing_progress, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of batches) await batchStmt.run(...row);

    // Seed Production Batch Items (Multiple items supported, production_cost is total cost!)
    const batchItems = [
      [1, 4, 300, 13500000],  // BCH-260: Concrete Tee, qty 300, total cost 13.5M
      [1, 5, 50, 6000000],    // BCH-260: Static Hoodie, qty 50, total cost 6M
      [2, 5, 150, 18000000],  // BCH-259: Static Hoodie, qty 150, total cost 18M
      [3, 6, 80, 14400000],   // BCH-258: Asphalt Jacket, qty 80, total cost 14.4M
      [4, 7, 120, 13200000],  // BCH-257: Block 88 Pants, qty 120, total cost 13.2M
      [5, 4, 200, 9000000]    // BCH-256: Concrete Tee, qty 200, total cost 9M (Sampling)
    ];
    const batchItemStmt = await db.prepare(`
      INSERT INTO production_batch_items (batch_id, product_id, qty, production_cost)
      VALUES (?, ?, ?, ?)
    `);
    for (const row of batchItems) await batchItemStmt.run(...row);

    // Seed BOM
    const boms = [
      [4, "Heavy Cotton Combed 20s", 1.4, "meter"],
      [4, "Thread", 1.0, "pcs"],
      [5, "Cotton Fleece Fabric", 1.6, "meter"],
      [5, "Ribbing Fabric", 0.2, "meter"],
      [6, "Twill Cotton Fabric", 1.8, "meter"],
      [6, "Buttons", 6.0, "pcs"],
      [7, "Canvas Fabric", 1.7, "meter"],
      [7, "Metal Buttons", 1.0, "pcs"]
    ];
    const bomStmt = await db.prepare("INSERT INTO bill_of_materials (product_id, material_name, required_qty, unit) VALUES (?, ?, ?, ?)");
    for (const row of boms) await bomStmt.run(...row);

    await seedOrder("ORD-TKP-1001", "Marketplace", "Tokopedia", 1, 1, [[5, 2], [7, 1]], 0, 18000, 21000, "Marketplace");
    await seedOrder("ORD-SHP-1002", "Marketplace", "Shopee", 2, 1, [[6, 1], [8, 2]], 15000, 16000, 19000, "Marketplace");
    await seedOrder("ORD-OFF-1003", "Offline", "Store", 3, 2, [[9, 1], [7, 2]], 10000, 0, 0, "QRIS");
    await seedOrder("ORD-OFF-1004", "Offline", "Event", 4, 2, [[10, 1], [5, 1]], 0, 0, 0, "Cash");

    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

async function seedMonthlyRevenue() {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM monthly_revenues").get();
  const count = Number(row ? row.total : 0);
  if (count > 0) return;
  const stmt = await db.prepare(`
    INSERT INTO monthly_revenues (month, online_revenue, offline_revenue, online_notes, offline_notes)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (month) DO NOTHING
  `);
  const revs = [
    ["2026-01", 17400000, 9200000, "Tokopedia kuat di hoodie", "Event awal tahun"],
    ["2026-02", 19600000, 11800000, "Shopee promo payday", "Store naik weekend"],
    ["2026-03", 23100000, 14300000, "Drop T-shirt", "Pop-up Bandung"],
    ["2026-04", 21800000, 15200000, "Ads marketplace stabil", "Reseller masuk"],
    ["2026-05", 26700000, 17100000, "Campaign bundle", "Event kampus"],
    ["2026-06", 29400000, 18400000, "Tokopedia + Shopee", "Store + direct order"]
  ];
  for (const row of revs) {
    await stmt.run(...row);
  }
}

async function seedMonthlyExpenses() {
  const row = await db.prepare("SELECT COUNT(*) AS total FROM monthly_expenses").get();
  const count = Number(row ? row.total : 0);
  if (count > 0) return;
  const stmt = await db.prepare("INSERT INTO monthly_expenses (month, category, amount, note) VALUES (?, ?, ?, ?)");
  const exps = [
    ["2026-01", "Produksi", 11000000, "Produksi awal tahun"],
    ["2026-02", "Bahan Baku", 12500000, "Cotton fleece dan rib"],
    ["2026-03", "Marketing", 4200000, "Ads marketplace"],
    ["2026-04", "Operasional", 6800000, "Booth dan packaging"],
    ["2026-05", "Produksi", 15100000, "Restock artikel best seller"],
    ["2026-06", "Bahan Baku", 17300000, "Kain, sablon, jahit"]
  ];
  for (const row of exps) {
    await stmt.run(...row);
  }
}

async function personalizeExistingData() {
  // No-op
}

async function seedOrder(orderNo, revenueStream, channel, customerId, poolId, items, discount, shippingFee, platformFee, paymentMethod) {
  const order = await db.prepare(`
    INSERT INTO sales_orders
    (order_no, revenue_stream, channel, customer_id, discount, shipping_fee, platform_fee, payment_method)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderNo, revenueStream, channel, customerId, discount, shippingFee, platformFee, paymentMethod);
  const itemStmt = await db.prepare(`
    INSERT INTO sales_order_items (order_id, variant_id, qty, price, cost_price)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [variantId, qty] of items) {
    const variant = await db.prepare("SELECT sell_price, cost_price FROM variants WHERE id = ?").get(variantId);
    await itemStmt.run(order.lastInsertRowid, variantId, qty, variant.sell_price, variant.cost_price);
    await changeStock(variantId, poolId, -qty, "Sale", orderNo);
  }
}

async function changeStock(variantId, poolId, qty, type, note, createdAt = "") {
  await db.prepare(`
    INSERT INTO inventory_balances (variant_id, pool_id, qty)
    VALUES (?, ?, 0)
    ON CONFLICT(variant_id, pool_id) DO NOTHING
  `).run(variantId, poolId);
  await db.prepare("UPDATE inventory_balances SET qty = qty + ? WHERE variant_id = ? AND pool_id = ?").run(qty, variantId, poolId);
  if (createdAt) {
    await db.prepare("INSERT INTO stock_movements (variant_id, pool_id, type, qty, note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      variantId,
      poolId,
      type,
      qty,
      note,
      createdAt
    );
  } else {
    await db.prepare("INSERT INTO stock_movements (variant_id, pool_id, type, qty, note) VALUES (?, ?, ?, ?, ?)").run(
      variantId,
      poolId,
      type,
      qty,
      note
    );
  }
}

// initDb();

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const JWT_SECRET = process.env.JWT_SECRET || "default_tera_secret_key_1234567890";

function createToken(user) {
  const payload = JSON.stringify({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  });
  const base64Payload = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", JWT_SECRET).update(base64Payload).digest("base64url");
  return `${base64Payload}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expectedSignature = createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
  if (signature !== expectedSignature) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
}

function requireUser(req) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  return verifyToken(token);
}

async function dashboard() {
  const revenue = await db.prepare(`
    WITH monthly_cogs AS (
      SELECT 
        monthly_revenue_id,
        SUM(online_qty * v.cost_price) AS online_cogs,
        SUM(offline_qty * v.cost_price) AS offline_cogs
      FROM monthly_revenue_items mri
      JOIN variants v ON v.id = mri.variant_id
      GROUP BY monthly_revenue_id
    ),
    channel_summary AS (
      SELECT 
        'Online' AS channel,
        'Marketplace' AS stream,
        SUM(mr.online_revenue) AS net_revenue,
        SUM(COALESCE(mc.online_cogs, 0)) AS cogs,
        COUNT(mr.id) AS orders
      FROM monthly_revenues mr
      LEFT JOIN monthly_cogs mc ON mc.monthly_revenue_id = mr.id
      
      UNION ALL
      
      SELECT 
        'Offline' AS channel,
        'Store' AS stream,
        SUM(mr.offline_revenue) AS net_revenue,
        SUM(COALESCE(mc.offline_cogs, 0)) AS cogs,
        COUNT(mr.id) AS orders
      FROM monthly_revenues mr
      LEFT JOIN monthly_cogs mc ON mc.monthly_revenue_id = mr.id
    )
    SELECT channel, stream, net_revenue, cogs, orders
    FROM channel_summary
    ORDER BY net_revenue DESC
  `).all();
  const inventory = await db.prepare(`
    SELECT ip.name AS pool, SUM(ib.qty * v.sell_price) AS value, SUM(ib.qty) AS qty
    FROM inventory_balances ib
    JOIN variants v ON v.id = ib.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN inventory_pools ip ON ip.id = ib.pool_id
    WHERE p.category NOT IN ('Bahan Baku', 'Aksesoris')
    GROUP BY ip.id, ip.name
  `).all();
  const stockByArticle = await db.prepare(`
    SELECT p.name, SUM(ib.qty) AS total_qty,
      SUM(CASE WHEN ip.name = 'Online Inventory' THEN ib.qty ELSE 0 END) AS online_qty,
      SUM(CASE WHEN ip.name = 'Offline Inventory' THEN ib.qty ELSE 0 END) AS offline_qty
    FROM inventory_balances ib
    JOIN variants v ON v.id = ib.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN inventory_pools ip ON ip.id = ib.pool_id
    WHERE p.category NOT IN ('Bahan Baku', 'Aksesoris')
    GROUP BY p.id, p.name
    ORDER BY total_qty DESC
  `).all();
  const lowStock = await db.prepare(`
    SELECT p.name, v.sku, v.size, v.color, ip.name AS pool, ib.qty, v.low_stock
    FROM inventory_balances ib
    JOIN variants v ON v.id = ib.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN inventory_pools ip ON ip.id = ib.pool_id
    WHERE ib.qty <= v.low_stock
    ORDER BY ib.qty ASC
  `).all();
  const monthlyRevenue = await db.prepare(`
    SELECT month, online_revenue, offline_revenue, online_revenue + offline_revenue AS total
    FROM monthly_revenues
    ORDER BY month ASC
  `).all();
  const monthlyStockMovement = await db.prepare(`
    SELECT substr(CAST(created_at AS TEXT), 1, 7) AS month, ABS(SUM(CASE WHEN qty < 0 THEN qty ELSE 0 END)) AS sold_qty,
      SUM(CASE WHEN qty > 0 THEN qty ELSE 0 END) AS stock_in
    FROM stock_movements
    GROUP BY substr(CAST(created_at AS TEXT), 1, 7)
    ORDER BY month ASC
  `).all();
  return { revenue, inventory, stockByArticle, lowStock, monthlyRevenue, monthlyStockMovement };
}

async function products() {
  return await db.prepare(`
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
}

async function movements(month = "") {
  const monthFilter = month ? "WHERE substr(CAST(sm.created_at AS TEXT), 1, 7) = ?" : "";
  const params = month ? [month] : [];
  return await db.prepare(`
    SELECT sm.id AS id, sm.created_at, sm.type, sm.qty, sm.note, ip.name AS pool, p.name, v.sku, v.size, v.color
    FROM stock_movements sm
    JOIN inventory_pools ip ON ip.id = sm.pool_id
    JOIN variants v ON v.id = sm.variant_id
    JOIN products p ON p.id = v.product_id
    ${monthFilter}
    ORDER BY sm.id DESC
    LIMIT 50
  `).all(...params);
}

async function monthlyRevenues() {
  const rows = await db.prepare(`
    SELECT *, online_revenue + offline_revenue AS total_revenue,
      online_revenue - offline_revenue AS difference
    FROM monthly_revenues
    ORDER BY month DESC
  `).all();
  const itemStmt = await db.prepare(`
    SELECT mri.variant_id, mri.online_qty, mri.offline_qty, p.name, v.sku
    FROM monthly_revenue_items mri
    JOIN variants v ON v.id = mri.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE mri.monthly_revenue_id = ?
    ORDER BY p.name, v.sku
  `);
  return await Promise.all(rows.map(async (row) => ({ ...row, items: await itemStmt.all(row.id) })));
}

async function monthlyExpenses() {
  return await db.prepare(`
    SELECT id, month, category, amount, note, created_at
    FROM monthly_expenses
    ORDER BY month DESC, id DESC
  `).all();
}

async function profitSummary() {
  return await db.prepare(`
    WITH revenue AS (
      SELECT month, online_revenue + offline_revenue AS revenue
      FROM monthly_revenues
    ),
    expense AS (
      SELECT month, SUM(amount) AS expense
      FROM monthly_expenses
      GROUP BY month
    )
    SELECT
      revenue.month,
      revenue.revenue,
      COALESCE(expense.expense, 0) AS expense,
      revenue.revenue - COALESCE(expense.expense, 0) AS profit,
      SUM(revenue.revenue - COALESCE(expense.expense, 0)) OVER (ORDER BY revenue.month) AS cumulative_profit
    FROM revenue
    LEFT JOIN expense ON expense.month = revenue.month
    ORDER BY revenue.month DESC
  `).all();
}

async function reverseMonthlyRevenueStock(month) {
  const revenue = await db.prepare("SELECT id FROM monthly_revenues WHERE month = ?").get(month);
  if (!revenue) return;
  const items = await db.prepare("SELECT variant_id, online_qty, offline_qty FROM monthly_revenue_items WHERE monthly_revenue_id = ?").all(revenue.id);
  for (const item of items) {
    if (item.online_qty) await changeStock(item.variant_id, 1, item.online_qty, "Revenue Edit Reversal", `REV-${month}`);
    if (item.offline_qty) await changeStock(item.variant_id, 2, item.offline_qty, "Revenue Edit Reversal", `REV-${month}`);
  }
  await db.prepare("DELETE FROM stock_movements WHERE note = ? AND type = 'Monthly Revenue Sale'").run(`REV-${month}`);
  await db.prepare("DELETE FROM monthly_revenue_items WHERE monthly_revenue_id = ?").run(revenue.id);
}

async function applyMonthlyRevenueItems(revenueId, month, items = []) {
  const stmt = await db.prepare(`
    INSERT INTO monthly_revenue_items (monthly_revenue_id, variant_id, online_qty, offline_qty)
    VALUES (?, ?, ?, ?)
  `);
  for (const item of items) {
    const variantId = Number(item.variantId || item.variant_id);
    const onlineQty = Number(item.onlineQty || item.online_qty || 0);
    const offlineQty = Number(item.offlineQty || item.offline_qty || 0);
    if (!variantId || (!onlineQty && !offlineQty)) continue;
    await stmt.run(revenueId, variantId, onlineQty, offlineQty);
    const movementDate = `${month}-01 12:00:00`;
    if (onlineQty) await changeStock(variantId, 1, -onlineQty, "Monthly Revenue Sale", `REV-${month}`, movementDate);
    if (offlineQty) await changeStock(variantId, 2, -offlineQty, "Monthly Revenue Sale", `REV-${month}`, movementDate);
  }
}

async function reports() {
  const channel = await db.prepare(`
    WITH monthly_cogs AS (
      SELECT 
        monthly_revenue_id,
        SUM(online_qty * v.cost_price) AS online_cogs,
        SUM(offline_qty * v.cost_price) AS offline_cogs
      FROM monthly_revenue_items mri
      JOIN variants v ON v.id = mri.variant_id
      GROUP BY monthly_revenue_id
    ),
    channel_summary AS (
      SELECT 
        'Online' AS channel,
        'Marketplace' AS revenue_stream,
        SUM(mr.online_revenue) AS revenue,
        SUM(COALESCE(mc.online_cogs, 0)) AS cogs
      FROM monthly_revenues mr
      LEFT JOIN monthly_cogs mc ON mc.monthly_revenue_id = mr.id
      
      UNION ALL
      
      SELECT 
        'Offline' AS channel,
        'Store' AS revenue_stream,
        SUM(mr.offline_revenue) AS revenue,
        SUM(COALESCE(mc.offline_cogs, 0)) AS cogs
      FROM monthly_revenues mr
      LEFT JOIN monthly_cogs mc ON mc.monthly_revenue_id = mr.id
    )
    SELECT channel, revenue_stream, revenue, cogs, (revenue - cogs) AS gross_profit
    FROM channel_summary
    ORDER BY revenue DESC
  `).all();
  const sku = await db.prepare(`
    SELECT p.name, v.sku,
      SUM(mri.online_qty + mri.offline_qty) AS sold_qty,
      SUM((mri.online_qty + mri.offline_qty) * v.sell_price) AS revenue,
      SUM((mri.online_qty + mri.offline_qty) * (v.sell_price - v.cost_price)) AS margin
    FROM monthly_revenue_items mri
    JOIN variants v ON v.id = mri.variant_id
    JOIN products p ON p.id = v.product_id
    GROUP BY v.id, p.name, v.sku
    ORDER BY margin DESC
  `).all();
  return { channel, sku };
}

async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const user = await db.prepare("SELECT id, name, email, role FROM users WHERE email = ? AND password_hash = ?")
      .get(String(body.email || "").trim().toLowerCase(), hashPassword(body.password || ""));
    if (!user) return json(res, 401, { error: "Email atau password salah" });
    const token = createToken(user);
    return json(res, 200, { token, user });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    return json(res, 400, { error: "Registrasi akun baru tidak diperbolehkan." });
  }

  const publicPaths = ["/api/auth/login", "/api/auth/register"];
  if (!publicPaths.includes(url.pathname)) {
    const user = requireUser(req);
    if (!user) return json(res, 401, { error: "Silakan login dulu" });
  }

  if (req.method === "GET" && url.pathname === "/api/me") return json(res, 200, requireUser(req));
  if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, await dashboard());
  if (req.method === "GET" && url.pathname === "/api/products") return json(res, 200, await products());
  if (req.method === "GET" && url.pathname === "/api/movements") return json(res, 200, await movements(url.searchParams.get("month") || ""));
  if (req.method === "GET" && url.pathname === "/api/monthly-revenues") return json(res, 200, await monthlyRevenues());
  if (req.method === "GET" && url.pathname === "/api/monthly-expenses") return json(res, 200, await monthlyExpenses());
  if (req.method === "GET" && url.pathname === "/api/profit-summary") return json(res, 200, await profitSummary());
  if (req.method === "GET" && url.pathname === "/api/reports") return json(res, 200, await reports());
  
  if (req.method === "GET" && url.pathname === "/api/production/batches") {
    try {
      const batches = await db.prepare(`
        SELECT pb.*
        FROM production_batches pb
        ORDER BY pb.id DESC
      `).all();

      const rows = await Promise.all(batches.map(async batch => {
        const items = await db.prepare(`
          SELECT pbi.*, p.name AS product_name, p.category AS product_category
          FROM production_batch_items pbi
          JOIN products p ON p.id = pbi.product_id
          WHERE pbi.batch_id = ?
        `).all(batch.id);
        return {
          ...batch,
          items
        };
      }));
      return json(res, 200, rows);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/production/batches") {
    const body = await readJson(req);
    const batchNo = String(body.batchNo || "").trim().toUpperCase();
    const batchType = String(body.batchType || "Final Production").trim();
    const dueDate = String(body.dueDate || "").trim();
    const items = body.items || []; // Array of { productId, qty, productionCost }

    if (!batchNo || !batchType || !dueDate || !items.length) {
      return json(res, 400, { error: "No. Batch, Tipe, Due Date, dan minimal 1 produk wajib diisi" });
    }

    await db.exec("BEGIN");
    try {
      const batchResult = await db.prepare(`
        INSERT INTO production_batches (batch_no, batch_type, due_date, status)
        VALUES (?, ?, ?, 'Sedang Diproses')
      `).run(batchNo, batchType, dueDate);

      const batchId = batchResult.lastInsertRowid;
      const itemStmt = await db.prepare(`
        INSERT INTO production_batch_items (batch_id, product_id, qty, production_cost)
        VALUES (?, ?, ?, ?)
      `);

      let totalCost = 0;
      for (const item of items) {
        const itemQty = Number(item.qty || 0);
        const unitCost = Number(item.productionCost || 0);
        const itemTotalCost = itemQty * unitCost;
        totalCost += itemTotalCost;
        await itemStmt.run(batchId, Number(item.productId), itemQty, itemTotalCost);
      }

      // Add to monthly expenses
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const currentMonthStr = `${year}-${month}`;

      await db.prepare(`
        INSERT INTO monthly_expenses (month, category, amount, note)
        VALUES (?, ?, ?, ?)
      `).run(currentMonthStr, "Produksi", totalCost, `Produksi: ${batchNo}`);

      await db.exec("COMMIT");
      return json(res, 201, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/production/batches/")) {
    const id = Number(url.pathname.split("/").at(-1));
    const body = await readJson(req);
    const cutting = Number(body.cuttingProgress ?? 0);
    const sewing = Number(body.sewingProgress ?? 0);
    const finishing = Number(body.finishingProgress ?? 0);
    const status = (cutting === 100 && sewing === 100 && finishing === 100) ? "Selesai" : "Sedang Diproses";
    try {
      await db.prepare(`
        UPDATE production_batches
        SET cutting_progress = ?, sewing_progress = ?, finishing_progress = ?, status = ?
        WHERE id = ?
      `).run(cutting, sewing, finishing, status, id);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/production/bom") {
    const rows = await db.prepare(`
      SELECT bom.*, p.name AS product_name
      FROM bill_of_materials bom
      JOIN products p ON p.id = bom.product_id
      ORDER BY p.name, bom.id
    `).all();
    return json(res, 200, rows);
  }

  if (req.method === "POST" && url.pathname === "/api/production/bom") {
    const body = await readJson(req);
    const productId = Number(body.productId);
    const materialName = String(body.materialName || "").trim();
    const requiredQty = Number(body.requiredQty);
    const unit = String(body.unit || "").trim();

    if (!productId || !materialName || isNaN(requiredQty) || !unit) {
      return json(res, 400, { error: "Semua field wajib diisi dengan benar" });
    }

    try {
      await db.prepare(`
        INSERT INTO bill_of_materials (product_id, material_name, required_qty, unit)
        VALUES (?, ?, ?, ?)
      `).run(productId, materialName, requiredQty, unit);
      return json(res, 201, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/purchase-orders") {
    const rows = await db.prepare(`
      SELECT po.*, s.name AS supplier_name, ip.name AS pool_name,
        COALESCE((SELECT SUM(qty * cost_price) FROM purchase_order_items WHERE purchase_order_id = po.id), 0) AS total_amount
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      JOIN inventory_pools ip ON ip.id = po.pool_id
      ORDER BY po.id DESC
    `).all();
    for (const r of rows) {
      r.items = await db.prepare(`
        SELECT poi.*, poi.material_name AS product_name, '' AS size, '' AS color, '' AS sku
        FROM purchase_order_items poi
        WHERE poi.purchase_order_id = ?
      `).all(r.id);
    }
    return json(res, 200, rows);
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/purchase-orders/")) {
    const id = Number(url.pathname.split("/").pop());
    const body = await readJson(req);
    const status = String(body.status);
    
    await db.exec("BEGIN");
    try {
      const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
      if (!po) return json(res, 404, { error: "PO tidak ditemukan" });
      
      await db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?").run(status, id);
      
      if (status === "Dibatalkan") {
        await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`PO: ${po.po_no}%`);
      }
      
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/purchase-orders") {
    const body = await readJson(req);
    const poNo = String(body.poNo || "").trim().toUpperCase();
    const supplierId = Number(body.supplierId);
    const poolId = Number(body.poolId || 1);
    const status = String(body.status || "Draft");
    const items = body.items || []; // Array of { materialName, qty, costPrice }

    if (!poNo || !supplierId || !items.length) return json(res, 400, { error: "No PO, Supplier, dan Item wajib diisi" });
    await db.exec("BEGIN");
    try {
      const result = await db.prepare(`
        INSERT INTO purchase_orders (po_no, supplier_id, pool_id, status)
        VALUES (?, ?, ?, ?)
      `).run(poNo, supplierId, poolId, status);
      const poId = result.lastInsertRowid;

      const itemStmt = await db.prepare(`
        INSERT INTO purchase_order_items (purchase_order_id, material_name, qty, cost_price)
        VALUES (?, ?, ?, ?)
      `);
      for (const item of items) {
        await itemStmt.run(poId, String(item.materialName).trim(), Number(item.qty), Number(item.costPrice));
      }

      // Add to monthly expenses immediately after creating PO
      const supplier = await db.prepare("SELECT name FROM suppliers WHERE id = ?").get(supplierId);
      const supplierName = supplier ? supplier.name : "";
      
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const currentMonthStr = `${year}-${month}`;
      
      const totalAmount = items.reduce((sum, item) => sum + (Number(item.qty) * Number(item.costPrice)), 0);
      
      await db.prepare(`
        INSERT INTO monthly_expenses (month, category, amount, note)
        VALUES (?, ?, ?, ?)
      `).run(currentMonthStr, "Purchase Order", totalAmount, `PO: ${poNo} (${supplierName})`);

      await db.exec("COMMIT");
      return json(res, 201, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/suppliers") {
    const rows = await db.prepare("SELECT * FROM suppliers ORDER BY name").all();
    return json(res, 200, rows);
  }

  if (req.method === "POST" && url.pathname === "/api/suppliers") {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const contact = String(body.contact || "").trim();
    if (!name) return json(res, 400, { error: "Nama supplier wajib diisi" });
    try {
      await db.prepare("INSERT INTO suppliers (name, contact) VALUES (?, ?)")
        .run(name, contact);
      return json(res, 201, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/purchase-orders/")) {
    const id = Number(url.pathname.split("/").pop());
    await db.exec("BEGIN");
    try {
      const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
      if (!po) return json(res, 404, { error: "PO tidak ditemukan" });



      await db.prepare("DELETE FROM purchase_order_items WHERE purchase_order_id = ?").run(id);
      await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`PO: ${po.po_no}%`);
      await db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(id);

      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/production/batches/")) {
    const id = Number(url.pathname.split("/").pop());
    await db.exec("BEGIN");
    try {
      const batch = await db.prepare("SELECT batch_no FROM production_batches WHERE id = ?").get(id);
      if (batch) {
        await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`Produksi: ${batch.batch_no}%`);
      }
      await db.prepare("DELETE FROM production_batches WHERE id = ?").run(id);
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/production/batches/") && url.pathname.endsWith("/cancel")) {
    const parts = url.pathname.split("/");
    const id = Number(parts[parts.length - 2]);
    await db.exec("BEGIN");
    try {
      const batch = await db.prepare("SELECT batch_no FROM production_batches WHERE id = ?").get(id);
      if (batch) {
        await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`Produksi: ${batch.batch_no}%`);
      }
      await db.prepare("UPDATE production_batches SET status = 'Dibatalkan' WHERE id = ?").run(id);
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/suppliers/")) {
    const id = Number(url.pathname.split("/").pop());
    try {
      await db.prepare("DELETE FROM suppliers WHERE id = ?").run(id);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/customers") {
    try {
      const rows = await db.prepare("SELECT * FROM customers ORDER BY id DESC").all();
      return json(res, 200, rows);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/keuangan/transactions") {
    const rows = await db.prepare(`
      SELECT * FROM (
        SELECT 
          id,
          month || '-01' AS tanggal,
          'Pemasukan' AS jenis,
          'Penjualan' AS kategori,
          'Pendapatan Bulanan (' || month || ')' AS deskripsi,
          (online_revenue + offline_revenue) AS jumlah
        FROM monthly_revenues
        
        UNION ALL
        
        SELECT 
          id,
          month || '-01' AS tanggal,
          'Pengeluaran' AS jenis,
          category AS kategori,
          note AS deskripsi,
          amount AS jumlah
        FROM monthly_expenses
      )
      ORDER BY tanggal DESC, id DESC
      LIMIT 100
    `).all();
    return json(res, 200, rows);
  }

  if (req.method === "GET" && url.pathname === "/api/debug-inventory") {
    try {
      const inventoryRaw = await db.prepare("SELECT * FROM inventory_balances").all();
      const pools = await db.prepare("SELECT * FROM inventory_pools").all();
      const productsRaw = await db.prepare("SELECT * FROM products").all();
      const variantsRaw = await db.prepare("SELECT * FROM variants").all();
      return json(res, 200, { inventoryRaw, pools, productsRaw, variantsRaw });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/options") {
    return json(res, 200, {
      variants: await products(),
      pools: await db.prepare("SELECT * FROM inventory_pools ORDER BY id").all(),
      suppliers: await db.prepare("SELECT * FROM suppliers ORDER BY name").all(),
      products: await db.prepare("SELECT * FROM products WHERE status != 'Archived' ORDER BY name").all(),
      bomMaterials: await db.prepare("SELECT DISTINCT material_name, unit FROM bill_of_materials ORDER BY material_name").all()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    const body = await readJson(req);
    const name = String(body.name || "").trim();
    const sku = String(body.sku || "").trim().toUpperCase();
    if (!name || !sku) return json(res, 400, { error: "Nama artikel dan SKU wajib diisi" });
    await db.exec("BEGIN");
    try {
      const product = await db.prepare("INSERT INTO products (name, category, status) VALUES (?, ?, 'Aktif')")
        .run(name, body.category || "T-Shirt");
      const variant = await db.prepare(`
        INSERT INTO variants (product_id, sku, size, color, cost_price, sell_price, low_stock)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.lastInsertRowid,
        sku,
        body.size || "All Size",
        body.color || "Black",
        Number(body.costPrice || 0),
        Number(body.sellPrice || 0),
        Number(body.lowStock || 5)
      );
      await changeStock(Number(variant.lastInsertRowid), 1, Number(body.onlineQty || 0), "Initial Stock", "Tambah artikel baru");
      await changeStock(Number(variant.lastInsertRowid), 2, Number(body.offlineQty || 0), "Initial Stock", "Tambah artikel baru");
      await db.exec("COMMIT");
      return json(res, 201, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/products/")) {
    const variantId = Number(url.pathname.split("/").at(-1));
    const body = await readJson(req);
    const current = await db.prepare(`
      SELECT v.id, p.id AS product_id
      FROM variants v
      JOIN products p ON p.id = v.product_id
      WHERE v.id = ?
    `).get(variantId);
    if (!current) return json(res, 404, { error: "Artikel tidak ditemukan" });
    await db.exec("BEGIN");
    try {
      await db.prepare("UPDATE products SET name = ?, category = ?, status = ? WHERE id = ?")
        .run(body.name, body.category, body.status || "Aktif", current.product_id);
      await db.prepare(`
        UPDATE variants
        SET sku = ?, size = ?, color = ?, cost_price = ?, sell_price = ?, low_stock = ?
        WHERE id = ?
      `).run(
        String(body.sku || "").trim().toUpperCase(),
        body.size || "All Size",
        body.color || "Black",
        Number(body.costPrice || 0),
        Number(body.sellPrice || 0),
        Number(body.lowStock || 5),
        variantId
      );
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/products/")) {
    const variantId = Number(url.pathname.split("/").at(-1));
    const current = await db.prepare("SELECT product_id FROM variants WHERE id = ?").get(variantId);
    if (!current) return json(res, 404, { error: "Artikel tidak ditemukan" });
    await db.prepare("UPDATE products SET status = 'Archived' WHERE id = ?").run(current.product_id);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/monthly-revenues") {
    const body = await readJson(req);
    await db.exec("BEGIN");
    try {
      await reverseMonthlyRevenueStock(body.month);
      await db.prepare(`
        INSERT INTO monthly_revenues (month, online_revenue, offline_revenue, online_notes, offline_notes, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(month) DO UPDATE SET
          online_revenue = excluded.online_revenue,
          offline_revenue = excluded.offline_revenue,
          online_notes = excluded.online_notes,
          offline_notes = excluded.offline_notes,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        body.month,
        Number(body.onlineRevenue || 0),
        Number(body.offlineRevenue || 0),
        body.onlineNotes || "",
        body.offlineNotes || ""
      );
      const revenue = await db.prepare("SELECT id FROM monthly_revenues WHERE month = ?").get(body.month);
      await applyMonthlyRevenueItems(revenue.id, body.month, body.items || []);
      await db.exec("COMMIT");
      return json(res, 201, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/monthly-revenues/")) {
    const month = decodeURIComponent(url.pathname.split("/").at(-1));
    await db.exec("BEGIN");
    try {
      await reverseMonthlyRevenueStock(month);
      await db.prepare("DELETE FROM monthly_revenues WHERE month = ?").run(month);
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/monthly-expenses") {
    const body = await readJson(req);
    if (!body.month || !body.category) return json(res, 400, { error: "Bulan dan kategori wajib diisi" });
    await db.prepare("INSERT INTO monthly_expenses (month, category, amount, note) VALUES (?, ?, ?, ?)")
      .run(body.month, body.category, Number(body.amount || 0), body.note || "");
    return json(res, 201, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/monthly-expenses/")) {
    const id = Number(url.pathname.split("/").at(-1));
    await db.prepare("DELETE FROM monthly_expenses WHERE id = ?").run(id);
    return json(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/movements/")) {
    const id = Number(url.pathname.split("/").at(-1));
    const movement = await db.prepare("SELECT variant_id, pool_id, qty FROM stock_movements WHERE id = ?").get(id);
    if (!movement) return json(res, 404, { error: "Riwayat pergerakan tidak ditemukan" });
    await db.exec("BEGIN");
    try {
      await db.prepare("UPDATE inventory_balances SET qty = qty - ? WHERE variant_id = ? AND pool_id = ?")
        .run(movement.qty, movement.variant_id, movement.pool_id);
      await db.prepare("DELETE FROM stock_movements WHERE id = ?").run(id);
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/stock/receive") {
    const body = await readJson(req);
    await changeStock(Number(body.variantId), Number(body.poolId), Number(body.qty), "Purchase", body.note || "Receive stock");
    return json(res, 201, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/stock/transfer") {
    const body = await readJson(req);
    const variantId = Number(body.variantId);
    const fromPoolId = Number(body.fromPoolId);
    const toPoolId = Number(body.toPoolId);
    const qty = Number(body.qty);
    if (fromPoolId === toPoolId) return json(res, 400, { error: "Pool asal dan tujuan harus berbeda" });
    await db.exec("BEGIN");
    try {
      await changeStock(variantId, fromPoolId, -qty, "Transfer Out", body.note || "Transfer stok");
      await changeStock(variantId, toPoolId, qty, "Transfer In", body.note || "Transfer stok");
      await db.prepare(`
        INSERT INTO stock_transfers (variant_id, from_pool_id, to_pool_id, qty, note)
        VALUES (?, ?, ?, ?, ?)
      `).run(variantId, fromPoolId, toPoolId, qty, body.note || "");
      await db.exec("COMMIT");
      return json(res, 201, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/system/reset") {
    await db.exec("PRAGMA foreign_keys = OFF");
    try {
      const tables = [
        "sales_order_items",
        "sales_orders",
        "purchase_order_items",
        "purchase_orders",
        "stock_transfers",
        "stock_movements",
        "inventory_balances",
        "monthly_revenue_items",
        "monthly_revenues",
        "monthly_expenses",
        "variants",
        "products",
        "customers",
        "suppliers",
        "inventory_pools",
        "users",
        "production_batch_items",
        "production_batches",
        "bill_of_materials"
      ];
      for (const table of tables) {
        await db.prepare(`DELETE FROM ${table}`).run();
      }
      await db.prepare("DELETE FROM sqlite_sequence").run();

      // Re-seed standard pools
      await db.prepare("INSERT INTO inventory_pools (name) VALUES (?), (?)").run("Online Inventory", "Offline Inventory");

      // Re-seed default users
      const stmt = await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)");
      await stmt.run("Owner TERA", "owner@tera.local", hashPassword("teraowner"), "Owner");
      await stmt.run("Admin TERA", "admin@tera.local", hashPassword("teraadmin"), "Admin");

      // Clear all active sessions
      sessions.clear();

      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    } finally {
      await db.exec("PRAGMA foreign_keys = ON");
    }
  }

  return json(res, 404, { error: "Not found" });
}

let dbInitialized = false;
async function ensureDbInitialized(client) {
  if (dbInitialized) return;
  await dbStorage.run(client, async () => {
    await initDb();
  });
  dbInitialized = true;
}

export default async function handler(req, res) {
  const client = await getDbClient();
  try {
    await ensureDbInitialized(client);
    await dbStorage.run(client, async () => {
      if (req.url.startsWith("/api/")) {
        await api(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });
  } catch (error) {
    console.error("Serverless Handler Error:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  } finally {
    client.release();
  }
}