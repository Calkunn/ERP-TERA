import { createHash, randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { getDbClient } from "./db.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import webpush from "web-push";

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
  // Run migration to add completed_at to production_batches if not exists
  try {
    await db.exec("ALTER TABLE production_batches ADD COLUMN completed_at TEXT");
  } catch (e) {
    // Ignore error if column already exists or table doesn't exist yet
  }

  // Run migration to add online_order_count to monthly_revenues if not exists
  try {
    await db.exec("ALTER TABLE monthly_revenues ADD COLUMN online_order_count INTEGER DEFAULT 0");
  } catch (e) {
    // Ignore error if column already exists
  }

  // Run migration to add category to purchase_order_items if not exists
  try {
    await db.exec("ALTER TABLE purchase_order_items ADD COLUMN category TEXT DEFAULT 'Bahan Baku'");
  } catch (e) {
    // Ignore error if column already exists
  }

  // Run migration to add image to products if not exists
  try {
    await db.exec("ALTER TABLE products ADD COLUMN image TEXT");
  } catch (e) {
    // Ignore error if column already exists
  }

  // Create app_settings table if not exists
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  } catch (e) {
    console.error("Migration error for app_settings:", e);
  }

  // Create push_subscriptions table if not exists
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error("Migration error for push_subscriptions:", e);
  }

  // Create and seed auxiliary_balances table if not exists
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS auxiliary_balances (
        name TEXT PRIMARY KEY,
        qty INTEGER NOT NULL DEFAULT 0
      )
    `);
    await db.prepare("INSERT INTO auxiliary_balances (name, qty) VALUES ('Packaging Baju', 0) ON CONFLICT(name) DO NOTHING").run();
    await db.prepare("INSERT INTO auxiliary_balances (name, qty) VALUES ('Packaging Order', 0) ON CONFLICT(name) DO NOTHING").run();
    await db.prepare("INSERT INTO auxiliary_balances (name, qty) VALUES ('Hangtag', 0) ON CONFLICT(name) DO NOTHING").run();
  } catch (e) {
    console.error("Migration error for auxiliary_balances:", e);
  }

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
      status TEXT NOT NULL DEFAULT 'Aktif',
      image TEXT
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
      online_order_count INTEGER NOT NULL DEFAULT 0,
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
      category TEXT DEFAULT 'Bahan Baku',
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
      completed_at TEXT,
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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
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

  await migrateDuplicateProducts();
  await migrateOfflineRevenuesToNet();
  await migrateRndExpenses();
}

let vapidKeys = null;
async function initVapid() {
  if (vapidKeys) return;
  
  // 1. Check if VAPID keys are provided in environment variables (Vercel env) - latest deployment trigger
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidKeys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
    console.log("Web Push VAPID loaded from environment variables.");
  } else {
    // 2. Fall back to database app_settings table
    try {
      const pub = await db.prepare("SELECT value FROM app_settings WHERE key = 'vapid_public_key'").get();
      const priv = await db.prepare("SELECT value FROM app_settings WHERE key = 'vapid_private_key'").get();
      
      if (pub && priv) {
        vapidKeys = { publicKey: pub.value, privateKey: priv.value };
        console.log("Web Push VAPID loaded from database settings.");
      } else {
        console.log("VAPID keys not found in database or environment. Generating fresh keypair...");
        const keys = webpush.generateVAPIDKeys();
        await db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid_public_key', ?)").run(keys.publicKey);
        await db.prepare("INSERT INTO app_settings (key, value) VALUES ('vapid_private_key', ?)").run(keys.privateKey);
        vapidKeys = keys;
      }
    } catch (e) {
      console.error("Failed to load VAPID details from database, generating temp in-memory keypair:", e);
      // Fallback: Generate in-memory temporary keys so it at least works for testing in this session
      const keys = webpush.generateVAPIDKeys();
      vapidKeys = keys;
    }
  }
  
  if (vapidKeys) {
    try {
      webpush.setVapidDetails(
        "mailto:admin@tera-erp.local",
        vapidKeys.publicKey,
        vapidKeys.privateKey
      );
      console.log("Web Push VAPID details registered successfully.");
    } catch (e) {
      console.error("Failed to set VAPID details:", e);
    }
  }
}

async function triggerBookkeepingPushNotifications(prevMonthStr) {
  try {
    const subscriptions = await db.prepare("SELECT * FROM push_subscriptions").all();
    if (subscriptions.length === 0) return;

    const [year, month] = prevMonthStr.split("-");
    const monthNames = [
      "Januari", "Februari", "Maret", "April", "Mei", "Juni",
      "Juli", "Agustus", "September", "Oktober", "November", "Desember"
    ];
    const indonesianMonthName = monthNames[parseInt(month, 10) - 1] || month;
    const monthLabel = `${indonesianMonthName} ${year}`;

    const payload = JSON.stringify({
      title: "⚠️ Peringatan Pembukuan",
      body: `Rekapitulasi pembukuan untuk bulan ${monthLabel} belum diinput. Harap segera lengkapi laporan Anda!`,
      url: "/#keuangan"
    });

    console.log(`Sending bookkeeping push notification for ${prevMonthStr} to ${subscriptions.length} subscribers...`);
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: {
            auth: sub.auth,
            p256dh: sub.p256dh
          }
        }, payload);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
        }
      }
    }
  } catch (e) {
    console.error("Failed to send push notifications:", e);
  }
}

async function migrateRndExpenses() {
  console.log("Starting RND expenses migration...");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS migration_versions (
      version TEXT PRIMARY KEY,
      migrated_at TEXT NOT NULL
    )
  `);
  
  const migrated = await db.prepare("SELECT 1 FROM migration_versions WHERE version = 'rnd_reclassification_v2'").get();
  if (migrated) {
    console.log("RND expenses migration already completed. Skipping.");
    return;
  }

  await db.exec("BEGIN");
  try {
    console.log("Reclassifying May/June Raw Material expenses to RND...");
    await db.prepare("UPDATE monthly_expenses SET category = 'RND' WHERE amount IN (416250, 416000) AND category = 'Bahan Baku'").run();
    await db.prepare("INSERT INTO migration_versions (version, migrated_at) VALUES ('rnd_reclassification_v2', CURRENT_TIMESTAMP)").run();
    await db.exec("COMMIT");
    console.log("RND expenses migration completed successfully!");
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("Failed to run RND expenses migration:", err);
  }
}

async function migrateOfflineRevenuesToNet() {
  console.log("Starting offline revenue commission migration...");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS migration_versions (
      version TEXT PRIMARY KEY,
      migrated_at TEXT NOT NULL
    )
  `);
  
  const migrated = await db.prepare("SELECT 1 FROM migration_versions WHERE version = 'offline_commission_deduction'").get();
  if (migrated) {
    console.log("Offline revenue commission migration already completed. Skipping.");
    return;
  }

  await db.exec("BEGIN");
  try {
    console.log("Updating existing offline revenues to net values (multiplying by 0.64)...");
    await db.prepare("UPDATE monthly_revenues SET offline_revenue = ROUND(offline_revenue * 0.64)").run();
    await db.prepare("INSERT INTO migration_versions (version, migrated_at) VALUES ('offline_commission_deduction', CURRENT_TIMESTAMP)").run();
    await db.exec("COMMIT");
    console.log("Offline revenue commission migration completed successfully!");
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("Failed to run offline revenue commission migration:", err);
  }
}

async function migrateDuplicateProducts() {
  console.log("Starting product size-variant migration...");
  await db.exec("BEGIN");
  try {
    const allProducts = await db.prepare("SELECT id, name, category FROM products").all();
    
    const getBaseProductName = (name) => {
      const clean = name.trim();
      const match = clean.match(/(.+)\s+(s|m|l|xl|xxl|xxxl|all\s+size)$/i);
      if (match) {
        return match[1].trim();
      }
      return clean;
    };

    const groups = new Map();
    for (const p of allProducts) {
      const baseName = getBaseProductName(p.name);
      const key = `${baseName.toLowerCase()}|||${p.category.toLowerCase()}`;
      if (!groups.has(key)) {
        groups.set(key, { baseName, category: p.category, items: [] });
      }
      groups.get(key).items.push(p);
    }

    for (const [key, group] of groups.entries()) {
      if (group.items.length <= 1) continue;

      group.items.sort((a, b) => a.id - b.id);
      const master = group.items[0];
      const duplicates = group.items.slice(1);

      console.log(`Merging duplicates for product "${group.baseName}" (Category: ${group.category}):`);
      console.log(`  Master ID: ${master.id} ("${master.name}")`);
      
      await db.prepare("UPDATE products SET name = ? WHERE id = ?").run(group.baseName, master.id);

      for (const dup of duplicates) {
        console.log(`  Merging duplicate ID: ${dup.id} ("${dup.name}") -> ${master.id}`);
        await db.prepare("UPDATE variants SET product_id = ? WHERE product_id = ?").run(master.id, dup.id);
        await db.prepare("UPDATE production_batch_items SET product_id = ? WHERE product_id = ?").run(master.id, dup.id);
        await db.prepare("UPDATE bill_of_materials SET product_id = ? WHERE product_id = ?").run(master.id, dup.id);
        await db.prepare("DELETE FROM products WHERE id = ?").run(dup.id);
      }
    }
    await db.exec("COMMIT");
    console.log("Product size-variant migration completed successfully!");
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("Failed to run product size-variant migration:", err);
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

  const current = await db.prepare("SELECT qty FROM inventory_balances WHERE variant_id = ? AND pool_id = ?").get(variantId, poolId);
  const currentQty = current ? current.qty : 0;
  if (currentQty + qty < 0) {
    const variant = await db.prepare("SELECT sku FROM variants WHERE id = ?").get(variantId);
    const pool = await db.prepare("SELECT name FROM inventory_pools WHERE id = ?").get(poolId);
    const skuName = variant ? variant.sku : `ID ${variantId}`;
    const poolName = pool ? pool.name : `Pool ${poolId}`;
    throw new Error(`Stok ${skuName} di ${poolName} tidak mencukupi! Stok saat ini: ${currentQty}, dikurangi: ${Math.abs(qty)}`);
  }

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
    WHERE p.category NOT IN ('Bahan Baku', 'Aksesoris') AND p.status != 'Archived'
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
    WHERE p.category NOT IN ('Bahan Baku', 'Aksesoris') AND p.status != 'Archived'
    GROUP BY p.id, p.name
    ORDER BY total_qty DESC
  `).all();
  const lowStock = await db.prepare(`
    SELECT p.id AS product_id, p.name, v.sku, v.size, v.color, ip.name AS pool, ib.qty, v.low_stock
    FROM inventory_balances ib
    JOIN variants v ON v.id = ib.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN inventory_pools ip ON ip.id = ib.pool_id
    WHERE ib.qty <= v.low_stock AND p.status != 'Archived'
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

  // Background check and trigger for bookkeeping push notifications
  try {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth(); // 0-indexed
    const currentDay = today.getDate();

    let prevYear = currentYear;
    let prevMonth = currentMonth;
    if (currentMonth === 0) {
      prevYear--;
      prevMonth = 12;
    }
    const prevMonthStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

    const hasData = await db.prepare("SELECT id FROM monthly_revenues WHERE month = ?").get(prevMonthStr);
    if (!hasData) {
      // Check if today is in the warning period (24th to end of month, or 1st to 10th of next month)
      if (currentDay >= 24 || currentDay <= 10) {
        const todayStr = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`;
        const lastSent = await db.prepare("SELECT value FROM app_settings WHERE key = 'last_bookkeeping_push_date'").get();
        if (!lastSent || lastSent.value !== todayStr) {
          if (!lastSent) {
            await db.prepare("INSERT INTO app_settings (key, value) VALUES ('last_bookkeeping_push_date', ?)").run(todayStr);
          } else {
            await db.prepare("UPDATE app_settings SET value = ? WHERE key = 'last_bookkeeping_push_date'").run(todayStr);
          }
          triggerBookkeepingPushNotifications(prevMonthStr).catch(err => console.error("Error in background push:", err));
        }
      }
    }
  } catch (e) {
    console.error("Error checking bookkeeping warning push notification:", e);
  }

  return { revenue, inventory, stockByArticle, lowStock, monthlyRevenue, monthlyStockMovement };
}

async function products() {
  return await db.prepare(`
    SELECT v.id AS variant_id, p.id AS product_id, p.name, p.category, p.status, p.image, v.sku, v.size, v.color,
      v.cost_price, v.sell_price, v.low_stock,
      COALESCE(SUM(CASE WHEN ip.name = 'Online Inventory' THEN ib.qty END), 0) AS online_qty,
      COALESCE(SUM(CASE WHEN ip.name = 'Offline Inventory' THEN ib.qty END), 0) AS offline_qty,
      COALESCE(SUM(ib.qty), 0) AS total_qty
    FROM variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN inventory_balances ib ON ib.variant_id = v.id
    LEFT JOIN inventory_pools ip ON ip.id = ib.pool_id
    WHERE p.status != 'Archived'
    GROUP BY v.id, p.id, p.name, p.category, p.status, p.image, v.sku, v.size, v.color, v.cost_price, v.sell_price, v.low_stock
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
  const revenues = await db.prepare(`
    SELECT month, (online_revenue + offline_revenue) AS revenue
    FROM monthly_revenues
    ORDER BY month ASC
  `).all();

  const expenses = await db.prepare(`
    SELECT month, amount
    FROM monthly_expenses
  `).all();

  if (revenues.length === 0) return [];

  const incomeMonths = revenues.map(r => r.month);

  const getMonthVal = (mStr) => {
    const [y, m] = mStr.split('-').map(Number);
    return y * 12 + m;
  };

  const expenseMap = new Map();
  for (const r of revenues) {
    expenseMap.set(r.month, 0);
  }

  for (const e of expenses) {
    let targetMonth = e.month;
    if (!expenseMap.has(e.month)) {
      const eVal = getMonthVal(e.month);
      let closestMonth = incomeMonths[0];
      let minDiff = Math.abs(eVal - getMonthVal(closestMonth));
      for (let i = 1; i < incomeMonths.length; i++) {
        const diff = Math.abs(eVal - getMonthVal(incomeMonths[i]));
        if (diff < minDiff) {
          minDiff = diff;
          closestMonth = incomeMonths[i];
        } else if (diff === minDiff) {
          if (getMonthVal(incomeMonths[i]) > getMonthVal(closestMonth)) {
            closestMonth = incomeMonths[i];
          }
        }
      }
      targetMonth = closestMonth;
    }
    expenseMap.set(targetMonth, expenseMap.get(targetMonth) + e.amount);
  }

  let cumulativeProfit = 0;
  const list = [];
  for (const r of revenues) {
    const revVal = r.revenue;
    const expVal = expenseMap.get(r.month) || 0;
    const profit = revVal - expVal;
    cumulativeProfit += profit;
    list.push({
      month: r.month,
      revenue: revVal,
      expense: expVal,
      profit: profit,
      cumulative_profit: cumulativeProfit
    });
  }

  return list.reverse();
}

async function reverseMonthlyRevenueStock(month) {
  const revenue = await db.prepare("SELECT id, online_order_count FROM monthly_revenues WHERE month = ?").get(month);
  if (!revenue) return;

  // Restore Packaging & Hangtag Stock
  const itemsToRestore = await db.prepare(`
    SELECT mri.online_qty, mri.offline_qty
    FROM monthly_revenue_items mri
    JOIN variants v ON v.id = mri.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE mri.monthly_revenue_id = ? AND p.category NOT IN ('Bahan Baku', 'Aksesoris', 'Packaging', 'Hangtag')
  `).all(revenue.id);
  
  let totalBajuSold = 0;
  for (const item of itemsToRestore) {
    totalBajuSold += (item.online_qty || 0) + (item.offline_qty || 0);
  }
  const onlineOrderCount = revenue.online_order_count || 0;
  
  if (totalBajuSold > 0) {
    await db.prepare("UPDATE auxiliary_balances SET qty = qty + ? WHERE name = 'Packaging Baju'").run(totalBajuSold);
    await db.prepare("UPDATE auxiliary_balances SET qty = qty + ? WHERE name = 'Hangtag'").run(totalBajuSold);
  }
  if (onlineOrderCount > 0) {
    await db.prepare("UPDATE auxiliary_balances SET qty = qty + ? WHERE name = 'Packaging Order'").run(onlineOrderCount);
  }

  const items = await db.prepare("SELECT variant_id, online_qty, offline_qty FROM monthly_revenue_items WHERE monthly_revenue_id = ?").all(revenue.id);
  for (const item of items) {
    if (item.online_qty) {
      await db.prepare(`
        INSERT INTO inventory_balances (variant_id, pool_id, qty)
        VALUES (?, 1, 0)
        ON CONFLICT(variant_id, pool_id) DO NOTHING
      `).run(item.variant_id);
      await db.prepare("UPDATE inventory_balances SET qty = qty + ? WHERE variant_id = ? AND pool_id = 1")
        .run(item.online_qty, item.variant_id);
    }
    if (item.offline_qty) {
      await db.prepare(`
        INSERT INTO inventory_balances (variant_id, pool_id, qty)
        VALUES (?, 2, 0)
        ON CONFLICT(variant_id, pool_id) DO NOTHING
      `).run(item.variant_id);
      await db.prepare("UPDATE inventory_balances SET qty = qty + ? WHERE variant_id = ? AND pool_id = 2")
        .run(item.offline_qty, item.variant_id);
    }
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

async function calculateKeuanganReports() {
  const revenues = await db.prepare(`
    SELECT mr.id, mr.month, mr.online_revenue, mr.offline_revenue, mr.online_order_count
    FROM monthly_revenues mr
    ORDER BY mr.month ASC
  `).all();

  const rawExpenses = await db.prepare(`
    SELECT id, month, category, amount, note
    FROM monthly_expenses
  `).all();

  const incomeMonths = revenues.map(r => r.month);

  const getMonthVal = (mStr) => {
    const [y, m] = mStr.split('-').map(Number);
    return y * 12 + m;
  };

  const expenses = rawExpenses.map(e => {
    const monthPart = e.month ? e.month.substring(0, 7) : "";
    if (incomeMonths.includes(monthPart)) return { ...e, month: monthPart };
    if (incomeMonths.length === 0) return { ...e, month: monthPart };

    const eVal = getMonthVal(monthPart);
    let closestMonth = incomeMonths[0];
    let minDiff = Math.abs(eVal - getMonthVal(closestMonth));
    for (let i = 1; i < incomeMonths.length; i++) {
      const diff = Math.abs(eVal - getMonthVal(incomeMonths[i]));
      if (diff < minDiff) {
        minDiff = diff;
        closestMonth = incomeMonths[i];
      } else if (diff === minDiff) {
        if (getMonthVal(incomeMonths[i]) > getMonthVal(closestMonth)) {
          closestMonth = incomeMonths[i];
        }
      }
    }
    return { ...e, month: closestMonth };
  });

  const cogsList = await db.prepare(`
    SELECT mr.month, SUM((mri.online_qty + mri.offline_qty) * v.cost_price) AS cogs
    FROM monthly_revenue_items mri
    JOIN variants v ON v.id = mri.variant_id
    JOIN monthly_revenues mr ON mr.id = mri.monthly_revenue_id
    GROUP BY mr.month
  `).all();

  const qtySoldList = await db.prepare(`
    SELECT mr.month, SUM(mri.online_qty + mri.offline_qty) AS qty_sold
    FROM monthly_revenue_items mri
    JOIN monthly_revenues mr ON mr.id = mri.monthly_revenue_id
    GROUP BY mr.month
  `).all();

  const cogsMap = new Map(cogsList.map(c => [c.month, c.cogs]));
  const qtyMap = new Map(qtySoldList.map(q => [q.month, q.qty_sold]));

  const expensesByMonth = {};
  for (const e of expenses) {
    if (!expensesByMonth[e.month]) {
      expensesByMonth[e.month] = [];
    }
    expensesByMonth[e.month].push(e);
  }

  const monthlyReports = [];
  const allMonths = Array.from(new Set([
    ...revenues.map(r => r.month),
    ...expenses.map(e => e.month)
  ])).sort();

  for (const m of allMonths) {
    const rev = revenues.find(r => r.month === m) || { online_revenue: 0, offline_revenue: 0, online_order_count: 0 };
    const grossOffline = Math.round(rev.offline_revenue / 0.64);
    const grossSales = rev.online_revenue + grossOffline;
    const monthExps = expensesByMonth[m] || [];
    const totalExpenses = monthExps.reduce((sum, e) => sum + e.amount, 0);

    if (grossSales === 0 && totalExpenses === 0) {
      continue;
    }

    const komisi = grossOffline - rev.offline_revenue;
    const totalRevenue = grossSales - komisi;
    const cogs = cogsMap.get(m) || 0;
    const operatingIncome = totalRevenue - cogs;
    
    // Gaji Karyawan = Sum of inputted 'Gaji Karyawan' expenses for this month
    const bayarDavid = monthExps
      .filter(e => e.category === 'Gaji Karyawan')
      .reduce((sum, e) => sum + e.amount, 0);

    const bahanBakuCost = monthExps.filter(e => e.category === 'Bahan Baku').reduce((sum, e) => sum + e.amount, 0);
    const purchaseOrderCost = monthExps.filter(e => e.category === 'Purchase Order').reduce((sum, e) => sum + e.amount, 0);
    const produksiCost = monthExps.filter(e => e.category === 'Produksi').reduce((sum, e) => sum + e.amount, 0);
    const jasaJahitCost = monthExps.filter(e => e.category === 'Jasa Jahit').reduce((sum, e) => sum + e.amount, 0);
    const sablonBordirCost = monthExps.filter(e => e.category === 'Sablon / Bordir').reduce((sum, e) => sum + e.amount, 0);
    const packagingCost = monthExps.filter(e => e.category === 'Packaging').reduce((sum, e) => sum + e.amount, 0);
    const hangtagCost = monthExps.filter(e => e.category === 'Hangtag').reduce((sum, e) => sum + e.amount, 0);

    const bahanKain = bahanBakuCost + purchaseOrderCost + produksiCost + jasaJahitCost + sablonBordirCost + packagingCost + hangtagCost;

    const operasionalCost = monthExps
      .filter(e => e.category === 'Operasional')
      .reduce((sum, e) => sum + e.amount, 0);

    const marketingCost = monthExps
      .filter(e => e.category === 'Marketing')
      .reduce((sum, e) => sum + e.amount, 0);

    const rndCost = monthExps
      .filter(e => e.category === 'RND')
      .reduce((sum, e) => sum + e.amount, 0);

    const lainnyaCost = monthExps
      .filter(e => e.category === 'Lainnya')
      .reduce((sum, e) => sum + e.amount, 0);

    const otherCost = operasionalCost + marketingCost + lainnyaCost + rndCost;

    // Produksi & Bahan Baku are excluded from the Income Statement (they are capitalized in inventory and deducted via COGS).
    const netIncome = operatingIncome - otherCost - bayarDavid;

    const qtySold = qtyMap.get(m) || 0;
    const avgPrice = qtySold > 0 ? Math.round(grossSales / qtySold) : 0;

    const cashReceived = totalRevenue;
    const cashReceivedLabel = 'Sales';

    let beginningCash = 0;
    if (m === '2026-03') {
      beginningCash = 3822450;
    } else if (monthlyReports.length > 0) {
      beginningCash = monthlyReports[monthlyReports.length - 1].endingCash;
    } else {
      beginningCash = 0;
    }

    const totalCashAvailable = beginningCash + cashReceived;
    
    const biayaGaji = bayarDavid;
    const otherExpenses = otherCost; 
    const totalCashDisbursement = bahanKain + biayaGaji + otherExpenses;
    const endingCash = totalCashAvailable - totalCashDisbursement;

    monthlyReports.push({
      month: m,
      grossSales,
      qtySold,
      avgPrice,
      komisi,
      totalRevenue,
      cogs,
      operatingIncome,
      bayarDavid,
      otherCost,
      operasionalCost,
      marketingCost,
      lainnyaCost,
      rndCost,
      bahanBakuCost,
      purchaseOrderCost,
      produksiCost,
      jasaJahitCost,
      sablonBordirCost,
      packagingCost,
      hangtagCost,
      netIncome,
      beginningCash,
      cashReceived,
      cashReceivedLabel,
      totalCashAvailable,
      bahanKain,
      biayaGaji,
      otherExpenses,
      totalCashDisbursement,
      endingCash
    });
  }
  return monthlyReports;
}

async function getAiContext() {
  const stockList = await db.prepare(`
    SELECT p.name, p.category, v.sku, v.size, v.color, SUM(ib.qty) AS qty, v.low_stock
    FROM inventory_balances ib
    JOIN variants v ON v.id = ib.variant_id
    JOIN products p ON p.id = v.product_id
    WHERE p.status != 'Archived'
    GROUP BY p.name, p.category, v.sku, v.size, v.color, v.low_stock
  `).all();

  const auxiliaryList = await db.prepare(`
    SELECT name, qty FROM auxiliary_balances
  `).all();

  const reports = await calculateKeuanganReports();

  return {
    stocks: stockList,
    auxiliary: auxiliaryList,
    financials: reports
  };
}

async function callGemini(systemInstruction, userMessage, history = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY_MISSING");
  }

  if (apiKey === "mock_api_key") {
    if (systemInstruction.includes("insights")) {
      return `* **[Stok]**: Stok Packaging Baju menipis.
* **[Keuangan]**: Laba operasional stabil.
* **[Pemasaran & Branding]**: Fokus branding T-Shirt.`;
    }
    return `Ini adalah respons simulasi dari Virtual COO untuk pesan: "${userMessage}".`;
  }

  const contents = [];
  for (const h of history) {
    contents.push({
      role: h.role === "user" ? "user" : "model",
      parts: [{ text: h.text }]
    });
  }
  contents.push({
    role: "user",
    parts: [{ text: userMessage }]
  });

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents,
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error: ${response.status} - ${errText}`);
  }

  const resJson = await response.json();
  const text = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned empty response.");
  }
  return text;
}

export async function cors(req, res) {
  // Allow any origin (or replace * with your domain) for public push API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') {
    // Short‑circuit preflight requests
    return json(res, 200, {});
  }
}

async function api(req, res) {
  // Apply CORS handling for every request
  const corsResult = await cors(req, res);
  if (corsResult) return corsResult; // OPTIONS preflight already responded
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/debug-push-db") {
    const isSqlite = dbStorage.getStore()?.db?.isSqlite || false;
    const diagnostics = {
      isSqlite,
      dbInitialized,
      vapidKeysLoadedBefore: !!vapidKeys,
      errors: []
    };
    
    // Attempt database migration manually
    try {
      await initDb();
      diagnostics.initDbSuccess = true;
    } catch (e) {
      diagnostics.initDbSuccess = false;
      diagnostics.errors.push("initDb error: " + e.message);
    }
    
    // Attempt initVapid manually
    try {
      await initVapid();
      diagnostics.initVapidSuccess = true;
      diagnostics.publicKey = vapidKeys ? vapidKeys.publicKey : null;
    } catch (e) {
      diagnostics.initVapidSuccess = false;
      diagnostics.errors.push("initVapid error: " + e.message);
    }

    // Inspect tables
    try {
      if (isSqlite) {
        const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        diagnostics.tables = tables.map(t => t.name);
      } else {
        const tables = await db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'").all();
        diagnostics.tables = tables.map(t => t.table_name);
      }
    } catch (e) {
      diagnostics.errors.push("Inspect tables error: " + e.message);
    }

    // Inspect app_settings content
    try {
      const settings = await db.prepare("SELECT * FROM app_settings").all();
      diagnostics.settings = settings;
    } catch (e) {
      diagnostics.errors.push("Inspect app_settings error: " + e.message);
    }

    // Inspect push_subscriptions count
    try {
      const subs = await db.prepare("SELECT COUNT(*) as count FROM push_subscriptions").get();
      diagnostics.pushSubscriptionsCount = subs ? subs.count : 0;
    } catch (e) {
      diagnostics.errors.push("Inspect push_subscriptions error: " + e.message);
    }

    return json(res, 200, diagnostics);
  }

  if (req.method === "GET" && url.pathname === "/api/debug-env") {
    return json(res, 200, {
      VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || null,
      VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || null,
      vapidKeysInMemory: vapidKeys ? true : false
    });
  }

  if (req.method === "GET" && url.pathname === "/api/push/public-key") {
    if (!vapidKeys) {
      await initVapid();
    }
    return json(res, 200, { publicKey: vapidKeys ? vapidKeys.publicKey : null });
  }

  if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
    const body = await readJson(req);
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return json(res, 400, { error: "Data subskripsi tidak lengkap" });
    }
    try {
      const exists = await db.prepare("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(body.endpoint);
      if (exists) {
        await db.prepare("UPDATE push_subscriptions SET p256dh = ?, auth = ? WHERE endpoint = ?")
          .run(body.keys.p256dh, body.keys.auth, body.endpoint);
      } else {
        await db.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)")
          .run(body.endpoint, body.keys.p256dh, body.keys.auth);
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") {
    const body = await readJson(req);
    if (!body.endpoint) {
      return json(res, 400, { error: "Endpoint wajib diisi" });
    }
    await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(body.endpoint);
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/push/test") {
    const subscriptions = await db.prepare("SELECT * FROM push_subscriptions").all();
    const payload = JSON.stringify({
      title: "Uji Coba TERA ERP 🎯",
      body: "Halo! Notifikasi uji coba PWA TERA ERP Anda berhasil dikirim ke perangkat ini.",
      url: "/#keuangan"
    });
    
    let sentCount = 0;
    let failCount = 0;
    
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: {
            auth: sub.auth,
            p256dh: sub.p256dh
          }
        }, payload);
        sentCount++;
      } catch (err) {
        console.error("Test notification delivery failed for endpoint:", sub.endpoint, err);
        failCount++;
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
        }
      }
    }
    
    return json(res, 200, { ok: true, sentCount, failCount });
  }

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

  if (req.method === "PUT" && url.pathname.startsWith("/api/production/batches/") && !url.pathname.endsWith("/details")) {
    const id = Number(url.pathname.split("/").at(-1));
    const body = await readJson(req);
    const cutting = Number(body.cuttingProgress ?? 0);
    const sewing = Number(body.sewingProgress ?? 0);
    const finishing = Number(body.finishingProgress ?? 0);
    const status = (cutting === 100 && sewing === 100 && finishing === 100) ? "Selesai" : "Sedang Diproses";
    const completedAt = body.completedAt ? body.completedAt.replace("T", " ") : "";
    await db.exec("BEGIN");
    try {
      const currentBatch = await db.prepare("SELECT batch_no, status FROM production_batches WHERE id = ?").get(id);
      if (!currentBatch) {
        await db.exec("ROLLBACK");
        return json(res, 404, { error: "Batch tidak ditemukan" });
      }

      const wasCompleted = currentBatch.status === "Selesai";
      const isCompletedNow = status === "Selesai";
      const dateToUse = completedAt || new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, 19);

      await db.prepare(`
        UPDATE production_batches
        SET cutting_progress = ?, sewing_progress = ?, finishing_progress = ?, status = ?, completed_at = ?
        WHERE id = ?
      `).run(cutting, sewing, finishing, status, isCompletedNow ? dateToUse : null, id);

      if (!wasCompleted && isCompletedNow) {
        const items = await db.prepare("SELECT product_id, qty FROM production_batch_items WHERE batch_id = ?").all(id);
        for (const item of items) {
          const variants = await db.prepare("SELECT id FROM variants WHERE product_id = ?").all(item.product_id);
          if (variants.length > 0) {
            const baseQty = Math.floor(item.qty / variants.length);
            const remainder = item.qty % variants.length;
            for (let i = 0; i < variants.length; i++) {
              const addedQty = baseQty + (i === 0 ? remainder : 0);
              if (addedQty > 0) {
                await changeStock(variants[i].id, 2, addedQty, "Production", `Selesai Produksi: ${currentBatch.batch_no}`, dateToUse);
              }
            }
          }
        }
      }

      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/production/batches/") && url.pathname.endsWith("/details")) {
    const parts = url.pathname.split("/");
    const id = Number(parts[parts.length - 2]);
    const body = await readJson(req);
    await db.exec("BEGIN");
    try {
      const batch = await db.prepare("SELECT * FROM production_batches WHERE id = ?").get(id);
      if (!batch) {
        await db.exec("ROLLBACK");
        return json(res, 404, { error: "Batch tidak ditemukan" });
      }

      const oldBatchNo = batch.batch_no;
      const oldStatus = batch.status;
      const oldCreatedAt = batch.created_at;
      const oldCompletedAt = batch.completed_at;

      // 1. Stock non-negative validation
      const netChanges = {};
      if (oldStatus === "Selesai") {
        const oldItems = await db.prepare("SELECT product_id, qty FROM production_batch_items WHERE batch_id = ?").all(id);
        for (const item of oldItems) {
          const variants = await db.prepare("SELECT id FROM variants WHERE product_id = ?").all(item.product_id);
          if (variants.length > 0) {
            const baseQty = Math.floor(item.qty / variants.length);
            const remainder = item.qty % variants.length;
            for (let i = 0; i < variants.length; i++) {
              const variantId = variants[i].id;
              const subQty = baseQty + (i === 0 ? remainder : 0);
              netChanges[variantId] = (netChanges[variantId] || 0) - subQty;
            }
          }
        }
        for (const item of body.items) {
          const variants = await db.prepare("SELECT id FROM variants WHERE product_id = ?").all(item.productId);
          if (variants.length > 0) {
            const baseQty = Math.floor(item.qty / variants.length);
            const remainder = item.qty % variants.length;
            for (let i = 0; i < variants.length; i++) {
              const variantId = variants[i].id;
              const addQty = baseQty + (i === 0 ? remainder : 0);
              netChanges[variantId] = (netChanges[variantId] || 0) + addQty;
            }
          }
        }
      }

      for (const [variantId, change] of Object.entries(netChanges)) {
        if (change < 0) {
          const bal = await db.prepare("SELECT qty FROM inventory_balances WHERE variant_id = ? AND pool_id = 2").get(Number(variantId));
          const currentQty = bal ? bal.qty : 0;
          if (currentQty + change < 0) {
            const variantInfo = await db.prepare("SELECT p.name, v.size, v.color FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?").get(Number(variantId));
            const name = variantInfo ? `${variantInfo.name} (${variantInfo.size}/${variantInfo.color})` : `Variant #${variantId}`;
            await db.exec("ROLLBACK");
            return json(res, 400, { error: `Stok tidak mencukupi untuk melakukan penyesuaian produksi. Stok ${name} di gudang offline akan menjadi negatif (${currentQty + change}).` });
          }
        }
      }

      // 2. Apply stock changes using netChanges
      if (oldStatus === "Selesai") {
        const dateToUse = oldCompletedAt || new Date(new Date().getTime() - new Date().getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, 19);
        for (const [variantId, change] of Object.entries(netChanges)) {
          if (change !== 0) {
            await changeStock(Number(variantId), 2, change, "Production Edit Adjustment", `Penyesuaian Batch: ${body.batchNo}`, dateToUse);
          }
        }
      }

      // 3. Update production batch details
      await db.prepare("UPDATE production_batches SET batch_no = ?, batch_type = ?, due_date = ? WHERE id = ?")
        .run(body.batchNo, body.batchType, body.dueDate, id);

      // 4. Delete and insert new items
      await db.prepare("DELETE FROM production_batch_items WHERE batch_id = ?").run(id);
      const itemStmt = await db.prepare(`
        INSERT INTO production_batch_items (batch_id, product_id, qty, production_cost)
        VALUES (?, ?, ?, ?)
      `);
      let newTotalCost = 0;
      for (const item of body.items) {
        const itemQty = Number(item.qty || 0);
        const unitCost = Number(item.productionCost || 0);
        const itemTotalCost = itemQty * unitCost;
        newTotalCost += itemTotalCost;
        await itemStmt.run(id, Number(item.productId), itemQty, itemTotalCost);
      }

      // 6. Update monthly expense
      await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`Produksi: ${oldBatchNo}%`);
      if (oldStatus !== "Dibatalkan") {
        const batchMonth = oldCreatedAt ? (oldCreatedAt instanceof Date ? oldCreatedAt.toISOString() : String(oldCreatedAt)).substring(0, 7) : new Date().toISOString().substring(0, 7);
        await db.prepare(`
          INSERT INTO monthly_expenses (month, category, amount, note)
          VALUES (?, ?, ?, ?)
        `).run(batchMonth, "Produksi", newTotalCost, `Produksi: ${body.batchNo}`);
      }

      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
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

  if (req.method === "PUT" && url.pathname.startsWith("/api/purchase-orders/") && !url.pathname.endsWith("/details")) {
    const id = Number(url.pathname.split("/").pop());
    const body = await readJson(req);
    const status = String(body.status);
    
    await db.exec("BEGIN");
    try {
      const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
      if (!po) return json(res, 404, { error: "PO tidak ditemukan" });
      
      const oldStatus = po.status;
      await db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?").run(status, id);
      
      if (status === "Selesai" && oldStatus !== "Selesai") {
        const items = await db.prepare("SELECT material_name, qty FROM purchase_order_items WHERE purchase_order_id = ?").all(id);
        for (const it of items) {
          const mName = it.material_name.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            await db.prepare("UPDATE auxiliary_balances SET qty = qty + ? WHERE name = ?").run(it.qty, mName);
          }
        }
      } else if (oldStatus === "Selesai" && status !== "Selesai") {
        const items = await db.prepare("SELECT material_name, qty FROM purchase_order_items WHERE purchase_order_id = ?").all(id);
        for (const it of items) {
          const mName = it.material_name.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            await db.prepare("UPDATE auxiliary_balances SET qty = qty - ? WHERE name = ?").run(it.qty, mName);
          }
        }
      }

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

  if (req.method === "PUT" && url.pathname.startsWith("/api/purchase-orders/") && url.pathname.endsWith("/details")) {
    const parts = url.pathname.split("/");
    const id = Number(parts[parts.length - 2]);
    const body = await readJson(req);
    await db.exec("BEGIN");
    try {
      const po = await db.prepare("SELECT * FROM purchase_orders WHERE id = ?").get(id);
      if (!po) {
        await db.exec("ROLLBACK");
        return json(res, 404, { error: "PO tidak ditemukan" });
      }

      const oldPoNo = po.po_no;
      const oldStatus = po.status;
      const oldCreatedAt = po.created_at;

      // 1. Stock non-negative validation for auxiliary stock
      const netAuxChanges = {};
      if (oldStatus === "Selesai") {
        const oldItems = await db.prepare("SELECT material_name, qty FROM purchase_order_items WHERE purchase_order_id = ?").all(id);
        for (const item of oldItems) {
          const mName = item.material_name.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            netAuxChanges[mName] = (netAuxChanges[mName] || 0) - item.qty;
          }
        }
      }
      if (body.status === "Selesai") {
        for (const item of body.items) {
          const mName = item.materialName.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            netAuxChanges[mName] = (netAuxChanges[mName] || 0) + item.qty;
          }
        }
      }

      for (const [mName, change] of Object.entries(netAuxChanges)) {
        if (change < 0) {
          const bal = await db.prepare("SELECT qty FROM auxiliary_balances WHERE name = ?").get(mName);
          const currentQty = bal ? bal.qty : 0;
          if (currentQty + change < 0) {
            await db.exec("ROLLBACK");
            return json(res, 400, { error: `Stok bahan pembantu tidak mencukupi untuk melakukan penyesuaian PO. Stok ${mName} akan menjadi negatif (${currentQty + change}).` });
          }
        }
      }

      // 2. Revert old auxiliary balances if old status was Selesai
      if (oldStatus === "Selesai") {
        const oldItems = await db.prepare("SELECT material_name, qty FROM purchase_order_items WHERE purchase_order_id = ?").all(id);
        for (const item of oldItems) {
          const mName = item.material_name.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            await db.prepare("UPDATE auxiliary_balances SET qty = qty - ? WHERE name = ?").run(item.qty, mName);
          }
        }
      }

      // 3. Update purchase order details
      await db.prepare("UPDATE purchase_orders SET po_no = ?, supplier_id = ?, pool_id = ?, status = ? WHERE id = ?")
        .run(body.poNo, body.supplierId, body.poolId, body.status, id);

      // 4. Delete and insert new items
      await db.prepare("DELETE FROM purchase_order_items WHERE purchase_order_id = ?").run(id);
      const poiStmt = await db.prepare(`
        INSERT INTO purchase_order_items (purchase_order_id, category, material_name, qty, cost_price)
        VALUES (?, ?, ?, ?, ?)
      `);
      let newTotalAmount = 0;
      for (const item of body.items) {
        const qty = Number(item.qty || 0);
        const cost = Number(item.costPrice || 0);
        newTotalAmount += qty * cost;
        await poiStmt.run(id, item.category, item.materialName, qty, cost);
      }

      // 5. Apply new auxiliary balances if new status is Selesai
      if (body.status === "Selesai") {
        for (const item of body.items) {
          const mName = item.materialName.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            await db.prepare("UPDATE auxiliary_balances SET qty = qty + ? WHERE name = ?").run(item.qty, mName);
          }
        }
      }

      // 6. Update monthly expense
      await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`PO: ${oldPoNo}%`);
      if (body.status !== "Dibatalkan") {
        const poMonth = oldCreatedAt ? (oldCreatedAt instanceof Date ? oldCreatedAt.toISOString() : String(oldCreatedAt)).substring(0, 7) : new Date().toISOString().substring(0, 7);
        const supplier = await db.prepare("SELECT name FROM suppliers WHERE id = ?").get(body.supplierId);
        const supplierName = supplier ? supplier.name : "";
        await db.prepare(`
          INSERT INTO monthly_expenses (month, category, amount, note)
          VALUES (?, ?, ?, ?)
        `).run(poMonth, "Purchase Order", newTotalAmount, `PO: ${body.poNo} (${supplierName})`);
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
        INSERT INTO purchase_order_items (purchase_order_id, category, material_name, qty, cost_price)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        await itemStmt.run(poId, String(item.category || 'Bahan Baku'), String(item.materialName).trim(), Number(item.qty), Number(item.costPrice));
        if (status === "Selesai") {
          const mName = String(item.materialName).trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            await db.prepare("UPDATE auxiliary_balances SET qty = qty + ? WHERE name = ?").run(Number(item.qty), mName);
          }
        }
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

      if (po.status === "Selesai") {
        const items = await db.prepare("SELECT material_name, qty FROM purchase_order_items WHERE purchase_order_id = ?").all(id);
        for (const it of items) {
          const mName = it.material_name.trim();
          if (["Packaging Baju", "Packaging Order", "Hangtag"].includes(mName)) {
            await db.prepare("UPDATE auxiliary_balances SET qty = qty - ? WHERE name = ?").run(it.qty, mName);
          }
        }
      }

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
      const batch = await db.prepare("SELECT batch_no, status FROM production_batches WHERE id = ?").get(id);
      if (batch) {
        if (batch.status === "Sedang Diproses") {
          await db.prepare("DELETE FROM monthly_expenses WHERE note LIKE ?").run(`Produksi: ${batch.batch_no}%`);
        } else if (batch.status === "Selesai") {
          const items = await db.prepare("SELECT product_id, qty FROM production_batch_items WHERE batch_id = ?").all(id);
          for (const item of items) {
            const variants = await db.prepare("SELECT id FROM variants WHERE product_id = ?").all(item.product_id);
            if (variants.length > 0) {
              const baseQty = Math.floor(item.qty / variants.length);
              const remainder = item.qty % variants.length;
              for (let i = 0; i < variants.length; i++) {
                const addedQty = baseQty + (i === 0 ? remainder : 0);
                if (addedQty > 0) {
                  await changeStock(variants[i].id, 2, -addedQty, "Production Deletion", `Hapus Batch: ${batch.batch_no}`);
                }
              }
            }
          }
        }
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
    await db.exec("BEGIN");
    try {
      await db.prepare("UPDATE purchase_orders SET supplier_id = NULL WHERE supplier_id = ?").run(id);
      await db.prepare("DELETE FROM suppliers WHERE id = ?").run(id);
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
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
      const category = body.category || "T-Shirt";
      let productId;
      
      const existingProduct = await db.prepare("SELECT id FROM products WHERE name = ? AND category = ?").get(name, category);
      if (existingProduct) {
        productId = existingProduct.id;
        if (body.image) {
          await db.prepare("UPDATE products SET status = 'Aktif', image = ? WHERE id = ?").run(body.image, productId);
        } else {
          await db.prepare("UPDATE products SET status = 'Aktif' WHERE id = ?").run(productId);
        }
      } else {
        const product = await db.prepare("INSERT INTO products (name, category, status, image) VALUES (?, ?, 'Aktif', ?)")
          .run(name, category, body.image || null);
        productId = product.lastInsertRowid;
      }

      // Split sizes by comma
      const sizesStr = String(body.size || "All Size");
      const sizes = sizesStr.split(",").map(s => s.trim()).filter(Boolean);
      
      if (sizes.length === 0) {
        sizes.push("All Size");
      }

      for (const size of sizes) {
        // Generate variant SKU: if multiple sizes, append size suffix
        let variantSku = sku;
        if (sizes.length > 1) {
          const suffix = `-${size.toUpperCase()}`;
          if (!sku.endsWith(suffix)) {
            variantSku = sku + suffix;
          }
        }

        // Check if variant SKU already exists
        const existingVariant = await db.prepare("SELECT id FROM variants WHERE sku = ?").get(variantSku);
        if (existingVariant) {
          await db.prepare(`
            UPDATE variants 
            SET product_id = ?, size = ?, color = ?, cost_price = ?, sell_price = ?, low_stock = ?
            WHERE id = ?
          `).run(
            productId,
            size,
            body.color || "Black",
            Number(body.costPrice || 0),
            Number(body.sellPrice || 0),
            Number(body.lowStock || 5),
            existingVariant.id
          );
        } else {
          const variant = await db.prepare(`
            INSERT INTO variants (product_id, sku, size, color, cost_price, sell_price, low_stock)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            productId,
            variantSku,
            size,
            body.color || "Black",
            Number(body.costPrice || 0),
            Number(body.sellPrice || 0),
            Number(body.lowStock || 5)
          );
          await changeStock(Number(variant.lastInsertRowid), 1, 0, "Initial Stock", "Tambah artikel baru");
          await changeStock(Number(variant.lastInsertRowid), 2, 0, "Initial Stock", "Tambah artikel baru");
        }
      }
      
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
      if (body.image !== undefined) {
        await db.prepare("UPDATE products SET name = ?, category = ?, status = ?, image = ? WHERE id = ?")
          .run(body.name, body.category, body.status || "Aktif", body.image, current.product_id);
      } else {
        await db.prepare("UPDATE products SET name = ?, category = ?, status = ? WHERE id = ?")
          .run(body.name, body.category, body.status || "Aktif", current.product_id);
      }
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

      // Handle stock editing
      if (body.onlineQty !== undefined) {
        const newOnline = Number(body.onlineQty || 0);
        const currentOnline = await db.prepare("SELECT qty FROM inventory_balances WHERE variant_id = ? AND pool_id = 1").get(variantId);
        const oldOnline = currentOnline ? currentOnline.qty : 0;
        const diff = newOnline - oldOnline;
        if (diff !== 0) {
          await changeStock(variantId, 1, diff, "Stock Adjustment", "Penyesuaian stok manual lewat detail produk");
        }
      }
      if (body.offlineQty !== undefined) {
        const newOffline = Number(body.offlineQty || 0);
        const currentOffline = await db.prepare("SELECT qty FROM inventory_balances WHERE variant_id = ? AND pool_id = 2").get(variantId);
        const oldOffline = currentOffline ? currentOffline.qty : 0;
        const diff = newOffline - oldOffline;
        if (diff !== 0) {
          await changeStock(variantId, 2, diff, "Stock Adjustment", "Penyesuaian stok manual lewat detail produk");
        }
      }

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
    
    const otherVariants = await db.prepare("SELECT COUNT(*) AS total FROM variants WHERE product_id = ? AND id != ?")
      .get(current.product_id, variantId);
    const hasOther = Number(otherVariants ? otherVariants.total : 0) > 0;
    
    await db.exec("BEGIN");
    try {
      // Wiping out inventory data explicitly to ensure it is deleted
      await db.prepare("DELETE FROM inventory_balances WHERE variant_id = ?").run(variantId);
      await db.prepare("DELETE FROM stock_movements WHERE variant_id = ?").run(variantId);
      await db.prepare("DELETE FROM stock_transfers WHERE variant_id = ?").run(variantId);
      await db.prepare("DELETE FROM variants WHERE id = ?").run(variantId);

      if (!hasOther) {
        await db.prepare("UPDATE products SET status = 'Archived' WHERE id = ?").run(current.product_id);
      }
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (err) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/monthly-revenues") {
    const body = await readJson(req);
    await db.exec("BEGIN");
    try {
      await reverseMonthlyRevenueStock(body.month);
      await db.prepare(`
        INSERT INTO monthly_revenues (month, online_revenue, offline_revenue, online_order_count, online_notes, offline_notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(month) DO UPDATE SET
          online_revenue = excluded.online_revenue,
          offline_revenue = excluded.offline_revenue,
          online_order_count = excluded.online_order_count,
          online_notes = excluded.online_notes,
          offline_notes = excluded.offline_notes,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        body.month,
        Number(body.onlineRevenue || 0),
        Math.round(Number(body.offlineRevenue || 0) * 0.64),
        Number(body.onlineOrderCount || 0),
        body.onlineNotes || "",
        body.offlineNotes || ""
      );

      const revenue = await db.prepare("SELECT id FROM monthly_revenues WHERE month = ?").get(body.month);
      await applyMonthlyRevenueItems(revenue.id, body.month, body.items || []);

      // Deduct Packaging & Hangtags Stock
      const onlineOrderCount = Number(body.onlineOrderCount || 0);
      const itemsDeducted = await db.prepare(`
        SELECT mri.online_qty, mri.offline_qty
        FROM monthly_revenue_items mri
        JOIN variants v ON v.id = mri.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE mri.monthly_revenue_id = ? AND p.category NOT IN ('Bahan Baku', 'Aksesoris', 'Packaging', 'Hangtag')
      `).all(revenue.id);

      let totalBajuSold = 0;
      for (const item of itemsDeducted) {
        totalBajuSold += (item.online_qty || 0) + (item.offline_qty || 0);
      }

      if (totalBajuSold > 0) {
        await db.prepare("UPDATE auxiliary_balances SET qty = qty - ? WHERE name = 'Packaging Baju'").run(totalBajuSold);
        await db.prepare("UPDATE auxiliary_balances SET qty = qty - ? WHERE name = 'Hangtag'").run(totalBajuSold);
      }
      if (onlineOrderCount > 0) {
        await db.prepare("UPDATE auxiliary_balances SET qty = qty - ? WHERE name = 'Packaging Order'").run(onlineOrderCount);
      }

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
      const current = await db.prepare("SELECT qty FROM inventory_balances WHERE variant_id = ? AND pool_id = ?").get(movement.variant_id, movement.pool_id);
      const currentQty = current ? current.qty : 0;
      if (currentQty - movement.qty < 0) {
        const variant = await db.prepare("SELECT sku FROM variants WHERE id = ?").get(movement.variant_id);
        const pool = await db.prepare("SELECT name FROM inventory_pools WHERE id = ?").get(movement.pool_id);
        const skuName = variant ? variant.sku : `ID ${movement.variant_id}`;
        const poolName = pool ? pool.name : `Pool ${movement.pool_id}`;
        await db.exec("ROLLBACK");
        return json(res, 400, { error: `Stok ${skuName} di ${poolName} tidak mencukupi untuk menghapus riwayat ini! Stok saat ini: ${currentQty}, dikurangi: ${movement.qty}` });
      }

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
    await db.exec("BEGIN");
    try {
      await changeStock(Number(body.variantId), Number(body.poolId), Number(body.qty), "Purchase", body.note || "Receive stock");
      await db.exec("COMMIT");
      return json(res, 201, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
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
        "bill_of_materials",
        "ai_chat_messages",
        "ai_chat_sessions"
      ];
      for (const table of tables) {
        await db.prepare(`DELETE FROM ${table}`).run();
      }
      await db.prepare("DELETE FROM sqlite_sequence").run();

      // Re-seed standard pools
      await db.prepare("INSERT INTO inventory_pools (name) VALUES (?), (?)").run("Online Inventory", "Offline Inventory");

      // Re-seed default users
      const stmt = await db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)");
      await stmt.run("Owner TERA", "tera.essential@gmail.com", hashPassword("marksukaallen"), "Owner");
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

  if (req.method === "GET" && url.pathname === "/api/keuangan/reports") {
    try {
      const reports = await calculateKeuanganReports();
      return json(res, 200, reports);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/ai/insights") {
    if (!process.env.GEMINI_API_KEY) {
      return json(res, 400, {
        error: "GEMINI_API_KEY_MISSING",
        message: "API Key Gemini belum terkonfigurasi. Silakan tambahkan variabel lingkungan GEMINI_API_KEY di dashboard hosting Anda."
      });
    }
    try {
      const selectedMonth = url.searchParams.get("month");
      const context = await getAiContext();
      
      let financialsToSend = context.financials;
      let monthFocusPrompt = "";
      if (selectedMonth) {
        financialsToSend = context.financials.filter(f => f.month === selectedMonth);
        monthFocusPrompt = `\nFokus analisis Anda adalah khusus untuk bulan laporan keuangan: ${selectedMonth}.`;
      }

      const systemInstruction = `
You are the Chief Business Consultant and Virtual COO for TERA, a premium clothing brand. You speak Indonesian.
Analyze the provided real-time business data:
1. stocks: List of clothing products and their variant quantities.
2. auxiliary: Quantities of Packaging Baju, Packaging Order, and Hangtag.
3. financials: Monthly Income Statement and Cash Budget reports.${monthFocusPrompt}

Generate exactly 3 bullet points of proactive, practical insights (rekomendasi pintar). Use Markdown format.
The output format must be EXACTLY like this:
* **[Stok]**: <A brief operation/stock warning. Mention specific items below their low_stock or packaging materials below 30. Keep it short.>
* **[Keuangan]**: <A brief profit/cost/cash analysis based on the latest months. E.g., warnings about 36% commission or high payroll compared to Net Income.>
* **[Pemasaran & Branding]**: <A brief marketing/branding action. Suggest marketing the highest-margin items or event/promotion strategies to optimize sales.>

Do not write any intro or outro, just return the 3 bullet points. Be specific about TERA's products and numbers.
`;
      const userMessage = `Here is the current business state:
Stocks: ${JSON.stringify(context.stocks)}
Auxiliary: ${JSON.stringify(context.auxiliary)}
Financial Reports: ${JSON.stringify(financialsToSend)}`;

      const text = await callGemini(systemInstruction, userMessage);
      return json(res, 200, { insights: text });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/chat") {
    if (!process.env.GEMINI_API_KEY) {
      return json(res, 400, {
        error: "GEMINI_API_KEY_MISSING",
        message: "API Key Gemini belum terkonfigurasi. Silakan tambahkan variabel lingkungan GEMINI_API_KEY di dashboard hosting Anda."
      });
    }
    try {
      const body = await readJson(req);
      if (!body.message) {
        return json(res, 400, { error: "Pesan wajib diisi" });
      }

      const context = await getAiContext();
      const systemInstruction = `
You are the Chief Business Consultant and Virtual COO for TERA, a premium clothing brand. You speak Indonesian.
Your personality is sharp, friendly, professional, analytical, and business-savvy.
You have access to the real-time business data of TERA:
- Stocks: ${JSON.stringify(context.stocks)}
- Auxiliary: ${JSON.stringify(context.auxiliary)}
- Financial Reports: ${JSON.stringify(context.financials)}

Your job is to answer the user's questions about their business performance, marketing, branding, stock replenishment, and financial health.
Always relate your answers to the actual numbers and products (like 'Tera Premium T-Shirt', 'Packaging Baju', 'Hangtag', etc.) present in the data when relevant.
Keep your answers highly practical, actionable, and structured using markdown. Keep responses concise but comprehensive.
`;

      let history = [];
      let userMsgId = null;
      if (body.sessionId) {
        // Save user message in DB
        const result = await db.prepare("INSERT INTO ai_chat_messages (session_id, role, message) VALUES (?, 'user', ?)")
          .run(body.sessionId, body.message);
        userMsgId = result.lastInsertRowid;
        
        // Fetch history
        const rows = await db.prepare("SELECT role, message FROM ai_chat_messages WHERE session_id = ? ORDER BY id ASC")
          .all(body.sessionId);
        
        // Use history before the last inserted user message
        history = rows.slice(0, -1).map(r => ({
          role: r.role === "user" ? "user" : "model",
          text: r.message
        }));
      } else {
        history = body.history || [];
      }

      let text;
      try {
        text = await callGemini(systemInstruction, body.message, history);
      } catch (geminiError) {
        if (body.sessionId && userMsgId) {
          await db.prepare("DELETE FROM ai_chat_messages WHERE id = ?").run(userMsgId);
        }
        throw geminiError;
      }

      if (body.sessionId) {
        // Save AI response in DB
        await db.prepare("INSERT INTO ai_chat_messages (session_id, role, message) VALUES (?, 'model', ?)")
          .run(body.sessionId, text);
      }

      return json(res, 200, { response: text });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/ai/sessions") {
    try {
      const rows = await db.prepare("SELECT * FROM ai_chat_sessions ORDER BY id DESC").all();
      return json(res, 200, rows);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/ai/sessions") {
    try {
      const body = await readJson(req);
      const title = String(body.title || "Chat Baru").trim();
      const result = await db.prepare("INSERT INTO ai_chat_sessions (title) VALUES (?)").run(title);
      return json(res, 201, { id: Number(result.lastInsertRowid), title });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/ai/sessions/") && url.pathname.endsWith("/messages")) {
    const parts = url.pathname.split("/");
    const sessionId = Number(parts[parts.length - 2]);
    try {
      const rows = await db.prepare("SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY id ASC").all(sessionId);
      return json(res, 200, rows);
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/ai/sessions/")) {
    const id = Number(url.pathname.split("/").pop());
    try {
      await db.prepare("DELETE FROM ai_chat_sessions WHERE id = ?").run(id);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/keuangan/reports/")) {
    const month = decodeURIComponent(url.pathname.split("/").at(-1));
    await db.exec("BEGIN");
    try {
      await reverseMonthlyRevenueStock(month);
      await db.prepare("DELETE FROM monthly_revenues WHERE month = ?").run(month);
      await db.prepare("DELETE FROM monthly_expenses WHERE month = ?").run(month);
      await db.exec("COMMIT");
      return json(res, 200, { ok: true });
    } catch (error) {
      await db.exec("ROLLBACK");
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/inventory/categories") {
    try {
      const clothingStock = await db.prepare(`
        SELECT p.category, p.name AS product_name, MIN(v.id) AS variant_id, SUM(ib.qty) AS total_qty,
          SUM(CASE WHEN ip.name = 'Online Inventory' THEN ib.qty ELSE 0 END) AS online_qty,
          SUM(CASE WHEN ip.name = 'Offline Inventory' THEN ib.qty ELSE 0 END) AS offline_qty
        FROM inventory_balances ib
        JOIN variants v ON v.id = ib.variant_id
        JOIN products p ON p.id = v.product_id
        JOIN inventory_pools ip ON ip.id = ib.pool_id
        WHERE p.category NOT IN ('Bahan Baku', 'Aksesoris', 'Packaging', 'Hangtag') AND p.status != 'Archived'
        GROUP BY p.category, p.name
        ORDER BY p.category ASC, p.name ASC
      `).all();

      const auxiliaryStocks = await db.prepare(`
        SELECT name, qty FROM auxiliary_balances
      `).all();

      return json(res, 200, {
        clothing: clothingStock,
        auxiliary: auxiliaryStocks
      });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/inventory/auxiliary/")) {
    const name = decodeURIComponent(url.pathname.split("/").at(-1));
    const body = await readJson(req);
    const qty = Number(body.qty);
    if (isNaN(qty)) return json(res, 400, { error: "Jumlah qty tidak valid" });
    
    try {
      await db.prepare("UPDATE auxiliary_balances SET qty = ? WHERE name = ?").run(qty, name);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }

  return json(res, 404, { error: "Not found" });
}

let dbInitialized = false;
async function ensureDbInitialized(client) {
  if (dbInitialized) return;
  await dbStorage.run(client, async () => {
    await initDb();
    await initVapid();
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