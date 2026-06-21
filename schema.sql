-- Drop tables if they exist (clean setup)
DROP TABLE IF EXISTS bill_of_materials CASCADE;
DROP TABLE IF EXISTS production_batch_items CASCADE;
DROP TABLE IF EXISTS production_batches CASCADE;
DROP TABLE IF EXISTS purchase_order_items CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS sales_order_items CASCADE;
DROP TABLE IF EXISTS sales_orders CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS monthly_expenses CASCADE;
DROP TABLE IF EXISTS monthly_revenue_items CASCADE;
DROP TABLE IF EXISTS monthly_revenues CASCADE;
DROP TABLE IF EXISTS stock_transfers CASCADE;
DROP TABLE IF EXISTS stock_movements CASCADE;
DROP TABLE IF EXISTS inventory_balances CASCADE;
DROP TABLE IF EXISTS inventory_pools CASCADE;
DROP TABLE IF EXISTS variants CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Create tables
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('Owner', 'Admin')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Aktif'
);

CREATE TABLE variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku TEXT NOT NULL UNIQUE,
  size TEXT NOT NULL,
  color TEXT NOT NULL,
  cost_price INTEGER NOT NULL,
  sell_price INTEGER NOT NULL,
  low_stock INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE inventory_pools (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE inventory_balances (
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  pool_id INTEGER NOT NULL REFERENCES inventory_pools(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (variant_id, pool_id)
);

CREATE TABLE stock_movements (
  id SERIAL PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  pool_id INTEGER NOT NULL REFERENCES inventory_pools(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stock_transfers (
  id SERIAL PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  from_pool_id INTEGER NOT NULL REFERENCES inventory_pools(id) ON DELETE CASCADE,
  to_pool_id INTEGER NOT NULL REFERENCES inventory_pools(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Selesai',
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE monthly_revenues (
  id SERIAL PRIMARY KEY,
  month TEXT NOT NULL UNIQUE,
  online_revenue INTEGER NOT NULL DEFAULT 0,
  offline_revenue INTEGER NOT NULL DEFAULT 0,
  online_notes TEXT,
  offline_notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE monthly_revenue_items (
  id SERIAL PRIMARY KEY,
  monthly_revenue_id INTEGER NOT NULL REFERENCES monthly_revenues(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  online_qty INTEGER NOT NULL DEFAULT 0,
  offline_qty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE monthly_expenses (
  id SERIAL PRIMARY KEY,
  month TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  channel TEXT NOT NULL
);

CREATE TABLE sales_orders (
  id SERIAL PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  revenue_stream TEXT NOT NULL,
  channel TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'Selesai',
  discount INTEGER NOT NULL DEFAULT 0,
  shipping_fee INTEGER NOT NULL DEFAULT 0,
  platform_fee INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sales_order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  cost_price INTEGER NOT NULL
);

CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT
);

CREATE TABLE purchase_orders (
  id SERIAL PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  pool_id INTEGER NOT NULL REFERENCES inventory_pools(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'Diterima',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE purchase_order_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  material_name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  cost_price INTEGER NOT NULL
);

CREATE TABLE production_batches (
  id SERIAL PRIMARY KEY,
  batch_no TEXT NOT NULL UNIQUE,
  batch_type TEXT NOT NULL CHECK(batch_type IN ('Sampling', 'Final Production')),
  due_date TEXT NOT NULL,
  cutting_progress INTEGER DEFAULT 0,
  sewing_progress INTEGER DEFAULT 0,
  finishing_progress INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Sedang Diproses',
  completed_at TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE production_batch_items (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL,
  production_cost INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bill_of_materials (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  material_name TEXT NOT NULL,
  required_qty REAL NOT NULL,
  unit TEXT NOT NULL
);
