import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';

// Local analytics store. SQLite (built into Node 24) keeps the project dependency-free;
// the schema is plain SQL so it ports to PostgreSQL without structural changes.
function openDatabase(url) {
  if (url === ':memory:' || url === 'file::memory:') return new DatabaseSync(':memory:');
  if (!url.startsWith('file:')) throw new Error('DATABASE_URL must be a file: URL (e.g. file:data/app.db) for the bundled SQLite driver.');
  const path = resolve(process.cwd(), url.slice('file:'.length));
  mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}

export const db = openDatabase(process.env.NODE_ENV === 'test' ? ':memory:' : config.databaseUrl);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  shop TEXT PRIMARY KEY, name TEXT, currency TEXT, iana_timezone TEXT, primary_domain TEXT,
  myshopify_domain TEXT, plan TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS access_tokens (
  shop TEXT PRIMARY KEY, token_enc TEXT NOT NULL, scope TEXT, grant_type TEXT NOT NULL,
  expires_at INTEGER, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, shop TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS locations (id TEXT PRIMARY KEY, shop TEXT NOT NULL, name TEXT, active INTEGER);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, shop TEXT NOT NULL, name TEXT, created_at TEXT, processed_at TEXT, updated_at TEXT,
  local_date TEXT, cancelled_at TEXT, cancel_reason TEXT, test INTEGER, source_name TEXT, channel TEXT,
  financial_status TEXT, fulfillment_status TEXT, customer_id TEXT, customer_name TEXT, units INTEGER,
  gross REAL, discounts REAL, tax REAL, shipping REAL, total REAL, current_total REAL, refunded REAL,
  province TEXT, country TEXT, retail_location TEXT
);
CREATE INDEX IF NOT EXISTS orders_shop_date ON orders (shop, local_date);
CREATE INDEX IF NOT EXISTS orders_customer ON orders (customer_id);
CREATE TABLE IF NOT EXISTS order_line_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT, variant_id TEXT, title TEXT, variant_title TEXT, sku TEXT, quantity INTEGER,
  current_quantity INTEGER, gross REAL, discount REAL
);
CREATE INDEX IF NOT EXISTS line_items_order ON order_line_items (order_id);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE, shop TEXT NOT NULL,
  created_at TEXT, local_date TEXT, amount REAL
);
CREATE INDEX IF NOT EXISTS refunds_shop_date ON refunds (shop, local_date);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, shop TEXT NOT NULL, display_name TEXT, created_at TEXT, local_date TEXT, updated_at TEXT,
  number_of_orders INTEGER, amount_spent REAL, last_order_at TEXT, state TEXT
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, shop TEXT NOT NULL, title TEXT, handle TEXT, vendor TEXT, product_type TEXT, status TEXT,
  created_at TEXT, updated_at TEXT, total_inventory INTEGER
);
CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY, shop TEXT NOT NULL, product_id TEXT, title TEXT, sku TEXT, price REAL,
  inventory_item_id TEXT, inventory_quantity INTEGER, tracked INTEGER, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS variants_item ON variants (inventory_item_id);
CREATE TABLE IF NOT EXISTS inventory_levels (
  inventory_item_id TEXT NOT NULL, location_id TEXT NOT NULL, shop TEXT NOT NULL, available INTEGER, updated_at TEXT,
  PRIMARY KEY (inventory_item_id, location_id)
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY, topic TEXT, shop TEXT, received_at TEXT, processed_at TEXT, status TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS sync_state (
  shop TEXT NOT NULL, resource TEXT NOT NULL, last_updated_at TEXT, last_full_sync_at TEXT, last_run_at TEXT,
  complete INTEGER NOT NULL DEFAULT 0, record_count INTEGER, error TEXT, PRIMARY KEY (shop, resource)
);
-- First-party storefront tracking lives in its own table and is never mixed into Shopify order data.
CREATE TABLE IF NOT EXISTS tracking_events (
  event_id TEXT PRIMARY KEY, shop TEXT NOT NULL, name TEXT NOT NULL, client_id TEXT, occurred_at TEXT,
  local_date TEXT, product_id TEXT, received_at TEXT
);
CREATE INDEX IF NOT EXISTS tracking_shop_date ON tracking_events (shop, local_date, name);
`);

db.exec(`
-- Operating costs entered by the business (Shopify has no record of rent, wages, software, ...).
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
  amount REAL NOT NULL, frequency TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT, created_at TEXT NOT NULL
);
-- Daily ad spend, from an ad platform API or entered manually. source says which.
CREATE TABLE IF NOT EXISTS ad_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL, platform TEXT NOT NULL, date TEXT NOT NULL,
  amount REAL NOT NULL, currency TEXT, source TEXT NOT NULL, entry_id TEXT, updated_at TEXT NOT NULL,
  UNIQUE (shop, platform, date, source, entry_id)
);
CREATE INDEX IF NOT EXISTS ad_spend_shop_date ON ad_spend (shop, date);
`);

// Migration: product costs (Shopify "Cost per item"). Adding the column forces one full variant
// re-sync so every variant gets its cost; later syncs keep it current incrementally.
if (!db.prepare('PRAGMA table_info(variants)').all().some((column) => column.name === 'unit_cost')) {
  db.exec('ALTER TABLE variants ADD COLUMN unit_cost REAL');
  db.exec("UPDATE sync_state SET complete = 0 WHERE resource = 'variants'");
}

// Migration: payment processing fees per order (Shopify Payments reports them on each transaction).
// Adding the columns forces one full order re-sync so historical orders get their fees.
if (!db.prepare('PRAGMA table_info(orders)').all().some((column) => column.name === 'payment_fees')) {
  db.exec('ALTER TABLE orders ADD COLUMN payment_fees REAL');
  db.exec('ALTER TABLE orders ADD COLUMN gateways TEXT');
  db.exec("UPDATE sync_state SET complete = 0 WHERE resource = 'orders'");
}
// Migration: fixed-cost category (operating, people, software, advertising, other).
if (!db.prepare('PRAGMA table_info(costs)').all().some((column) => column.name === 'subcategory')) {
  db.exec("ALTER TABLE costs ADD COLUMN subcategory TEXT NOT NULL DEFAULT 'other'");
}

db.exec(`
-- Staff and timesheets entered by the business (Shopify has no wage or timesheet data).
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL, name TEXT NOT NULL, role TEXT,
  hourly_rate REAL NOT NULL, on_cost_pct REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL, staff_id INTEGER NOT NULL REFERENCES staff(id),
  date TEXT NOT NULL, hours REAL NOT NULL, rate REAL NOT NULL, on_cost_pct REAL NOT NULL, extra_costs REAL NOT NULL DEFAULT 0,
  note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shifts_shop_date ON shifts (shop, date);
CREATE TABLE IF NOT EXISTS settings (shop TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (shop, key));
`);

db.exec(`
-- Annual plan: one scenario per shop and year. NULL override = "Auto" (calculated); 0 = intentional zero.
CREATE TABLE IF NOT EXISTS annual_plans (
  shop TEXT NOT NULL, year INTEGER NOT NULL, growth_pct REAL, landed_cost REAL, cost_pct REAL, updated_at TEXT,
  PRIMARY KEY (shop, year)
);
CREATE TABLE IF NOT EXISTS annual_plan_months (
  shop TEXT NOT NULL, year INTEGER NOT NULL, month INTEGER NOT NULL, baseline REAL, theme TEXT,
  forecast REAL, stock_budget REAL, required_units INTEGER, ordered_units INTEGER,
  PRIMARY KEY (shop, year, month)
);
`);

export function transaction(work) {
  db.exec('BEGIN');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

// Converts a UTC timestamp into the shop's calendar date so "today" means the store's today.
export function localDate(iso, timeZone) {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
