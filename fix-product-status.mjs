import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/erp.sqlite");
const before = db.prepare("SELECT id, name, status FROM products").all();
console.log("BEFORE - Product statuses:");
console.log(JSON.stringify(before, null, 2));

// Fix: Update all products from Archived to Aktif
db.prepare("UPDATE products SET status = 'Aktif' WHERE 1=1").run();

const after = db.prepare("SELECT id, name, status FROM products").all();
console.log("\nAFTER - Product statuses:");
console.log(JSON.stringify(after, null, 2));

db.close();
