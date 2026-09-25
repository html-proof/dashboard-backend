import { db, localDate } from '../database/db.js';
import { addDays, bucketKey, bucketSql } from './dates.js';
import { isComplete, syncStatus } from '../shopify/sync.js';
import { getStore } from '../shopify/store.js';

// Sales rules (documented in every response under `definitions`):
//  - Test orders are excluded. Cancelled orders are excluded from sales and reported separately.
//  - Orders are dated by processedAt in the shop's timezone; refunds by their own creation date.
const SALES_WHERE = 'o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ?';

// Order-based figures computed from synced orders. Prices are as charged (tax-inclusive for tax-inclusive shops),
// so they differ from Shopify's tax-exclusive sales report — both are returned, clearly labelled.
export const DEFINITIONS = {
  basis: 'Order-based: computed from synced Admin API orders at the prices charged (tax-inclusive where the shop includes tax).',
  grossSales: 'Sum of line-item original prices × quantity (before discounts), non-test, non-cancelled orders.',
  discounts: 'Order-level total discounts.',
  refunds: 'Total refunded amount of refunds created in the range (includes any refunded shipping/tax).',
  netSales: 'Gross sales − discounts − refunds.',
  totalSales: 'Order totals at time of purchase (incl. tax and shipping), before refunds.',
  averageOrderValue: 'Total sales ÷ orders.',
  newCustomers: 'Customers whose first non-test order falls in the range.',
  returningCustomers: 'Customers ordering in the range who had ordered before the range.'
};

const round = (value) => (value == null ? null : Math.round(value * 100) / 100);

export function dataQuality(shop, resources) {
  const status = syncStatus(shop);
  const missing = resources.filter((resource) => !isComplete(shop, resource));
  const describe = (resource) => {
    const running = status.inProgress.find((p) => p.resource === resource);
    if (running) return `${resource} (loading, ${running.fetched.toLocaleString()} fetched so far)`;
    const row = status.resources.find((r) => r.resource === resource);
    return row?.error ? `${resource} (failed: ${row.error})` : `${resource} (not started)`;
  };
  return {
    complete: missing.length === 0,
    incompleteResources: missing,
    message: missing.length ? `First Shopify sync not finished for ${missing.map(describe).join(', ')}. These figures are partial until it completes.` : null,
    lastSync: Object.fromEntries(status.resources.map((row) => [row.resource, row.last_run_at]))
  };
}

export function salesSummary(shop, startDate, endDate) {
  const sales = db.prepare(`SELECT COUNT(*) AS orders, SUM(o.gross) AS gross, SUM(o.discounts) AS discounts, SUM(o.tax) AS tax,
      SUM(o.shipping) AS shipping, SUM(o.total) AS total, SUM(o.units) AS units FROM orders o WHERE ${SALES_WHERE}`).get(shop, startDate, endDate);
  const refunds = db.prepare(`SELECT COUNT(*) AS count, SUM(r.amount) AS amount FROM refunds r JOIN orders o ON o.id = r.order_id
      WHERE r.shop = ? AND o.test = 0 AND r.local_date BETWEEN ? AND ?`).get(shop, startDate, endDate);
  const cancelled = db.prepare(`SELECT COUNT(*) AS count FROM orders o WHERE o.shop = ? AND o.test = 0 AND o.cancelled_at IS NOT NULL AND o.local_date BETWEEN ? AND ?`).get(shop, startDate, endDate);
  const orders = sales.orders;
  const gross = sales.gross ?? 0; const discounts = sales.discounts ?? 0; const refunded = refunds.amount ?? 0;
  return {
    orders, units: sales.units ?? 0,
    grossSales: round(gross), discounts: round(discounts), refunds: round(refunded), refundCount: refunds.count,
    netSales: round(gross - discounts - refunded), taxes: round(sales.tax ?? 0), shipping: round(sales.shipping ?? 0),
    totalSales: round(sales.total ?? 0),
    averageOrderValue: orders ? round((sales.total ?? 0) / orders) : null,
    cancelledOrders: cancelled.count
  };
}

export function customerSummary(shop, startDate, endDate) {
  const row = db.prepare(`WITH firsts AS (
      SELECT customer_id, MIN(local_date) AS first_date FROM orders WHERE shop = ? AND test = 0 AND customer_id IS NOT NULL GROUP BY customer_id),
    buyers AS (SELECT DISTINCT o.customer_id FROM orders o WHERE ${SALES_WHERE} AND o.customer_id IS NOT NULL)
    SELECT COUNT(*) AS buyers,
      SUM(CASE WHEN f.first_date >= ? THEN 1 ELSE 0 END) AS new_buyers,
      SUM(CASE WHEN f.first_date < ? THEN 1 ELSE 0 END) AS returning_buyers
    FROM buyers b JOIN firsts f ON f.customer_id = b.customer_id`).get(shop, shop, startDate, endDate, startDate, startDate);
  // Orders in the range placed by first-time buyers (the customer's first non-test order is in the range).
  const newOrders = db.prepare(`WITH firsts AS (
      SELECT customer_id, MIN(local_date) AS first_date FROM orders WHERE shop = ? AND test = 0 AND customer_id IS NOT NULL GROUP BY customer_id)
    SELECT COUNT(*) AS n FROM orders o JOIN firsts f ON f.customer_id = o.customer_id WHERE ${SALES_WHERE} AND f.first_date >= ?`).get(shop, shop, startDate, endDate, startDate);
  const created = db.prepare('SELECT COUNT(*) AS count FROM customers WHERE shop = ? AND local_date BETWEEN ? AND ?').get(shop, startDate, endDate);
  const total = db.prepare('SELECT COUNT(*) AS count FROM customers WHERE shop = ?').get(shop);
  return {
    totalCustomers: total.count, customerAccountsCreated: created.count,
    customersWhoOrdered: row.buyers, newCustomerOrders: newOrders.n, newCustomers: row.new_buyers ?? 0, returningCustomers: row.returning_buyers ?? 0,
    returningRate: row.buyers ? round((row.returning_buyers ?? 0) / row.buyers) : null
  };
}

export function fixedPeriods(shop) {
  const tz = getStore(shop)?.iana_timezone || 'UTC';
  const today = localDate(new Date().toISOString(), tz);
  const periods = {
    today: [today, today], yesterday: [addDays(today, -1), addDays(today, -1)], last_7_days: [addDays(today, -6), today],
    this_month: [`${today.slice(0, 7)}-01`, today], this_year: [`${today.slice(0, 4)}-01-01`, today]
  };
  return Object.fromEntries(Object.entries(periods).map(([key, [s, e]]) => {
    const summary = salesSummary(shop, s, e);
    return [key, { startDate: s, endDate: e, totalSales: summary.totalSales, netSales: summary.netSales, orders: summary.orders }];
  }));
}

// Returns every bucket in the range, including zero-sales buckets, so charts don't skip empty days.
export function trend(shop, range) {
  const { startDate, endDate, granularity } = range;
  const bucket = bucketSql('o.local_date', granularity);
  const rows = db.prepare(`SELECT ${bucket} AS bucket, COUNT(*) AS orders, SUM(o.total) AS total, SUM(o.gross) AS gross,
      SUM(o.discounts) AS discounts, SUM(o.units) AS units, COUNT(DISTINCT o.customer_id) AS customers
      FROM orders o WHERE ${SALES_WHERE} GROUP BY bucket`).all(shop, startDate, endDate);
  const refundRows = db.prepare(`SELECT ${bucketSql('r.local_date', granularity)} AS bucket, SUM(r.amount) AS refunds
      FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.shop = ? AND o.test = 0 AND r.local_date BETWEEN ? AND ? GROUP BY bucket`).all(shop, startDate, endDate);
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  const refundsByBucket = new Map(refundRows.map((row) => [row.bucket, row.refunds]));

  const buckets = [];
  const seen = new Set();
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    const key = bucketKey(day, granularity);
    if (!seen.has(key)) { seen.add(key); buckets.push(key); }
  }
  return buckets.map((key) => {
    const row = byBucket.get(key) || {};
    const refunds = refundsByBucket.get(key) ?? 0;
    return {
      period: key, orders: row.orders ?? 0, totalSales: round(row.total ?? 0), grossSales: round(row.gross ?? 0),
      netSales: round((row.gross ?? 0) - (row.discounts ?? 0) - refunds), refunds: round(refunds), units: row.units ?? 0, customers: row.customers ?? 0
    };
  });
}

export function breakdowns(shop, { startDate, endDate }, limit = 10) {
  const productRows = db.prepare(`SELECT li.product_id, li.title, SUM(li.quantity) AS units, SUM(li.gross - li.discount) AS revenue
      FROM order_line_items li JOIN orders o ON o.id = li.order_id WHERE ${SALES_WHERE}
      GROUP BY COALESCE(li.product_id, li.title) ORDER BY revenue DESC LIMIT ?`).all(shop, startDate, endDate, limit);
  const channel = db.prepare(`SELECT COALESCE(o.channel, 'Unknown') AS label, COUNT(*) AS orders, SUM(o.total) AS totalSales
      FROM orders o WHERE ${SALES_WHERE} GROUP BY label ORDER BY totalSales DESC`).all(shop, startDate, endDate);
  const location = db.prepare(`SELECT COALESCE(o.retail_location, CASE WHEN o.province IS NOT NULL THEN o.province || ', ' || o.country ELSE o.country END, 'No address') AS label,
      COUNT(*) AS orders, SUM(o.total) AS totalSales FROM orders o WHERE ${SALES_WHERE} GROUP BY label ORDER BY totalSales DESC LIMIT ?`).all(shop, startDate, endDate, limit);
  return {
    topProducts: productRows.map((row) => ({ productId: row.product_id, title: row.title, units: row.units, revenue: round(row.revenue) })),
    salesByChannel: channel.map((row) => ({ ...row, totalSales: round(row.totalSales) })),
    salesByLocation: location.map((row) => ({ ...row, totalSales: round(row.totalSales) }))
  };
}

export function statusBreakdown(shop, { startDate, endDate }) {
  const where = 'shop = ? AND test = 0 AND local_date BETWEEN ? AND ?';
  const financial = db.prepare(`SELECT COALESCE(financial_status, 'UNKNOWN') AS status, COUNT(*) AS orders, SUM(total) AS total FROM orders WHERE ${where} AND cancelled_at IS NULL GROUP BY status ORDER BY orders DESC`).all(shop, startDate, endDate);
  const fulfillment = db.prepare(`SELECT COALESCE(fulfillment_status, 'UNKNOWN') AS status, COUNT(*) AS orders FROM orders WHERE ${where} AND cancelled_at IS NULL GROUP BY status ORDER BY orders DESC`).all(shop, startDate, endDate);
  const cancelled = db.prepare(`SELECT COUNT(*) AS orders, SUM(total) AS total FROM orders WHERE ${where} AND cancelled_at IS NOT NULL`).get(shop, startDate, endDate);
  return { financial: financial.map((row) => ({ ...row, total: round(row.total) })), fulfillment, cancelled: { orders: cancelled.orders, total: round(cancelled.total ?? 0) } };
}

const ORDER_COLUMNS = `o.id, o.name, o.processed_at AS processedAt, o.local_date AS date, o.customer_name AS customer, o.units, o.gross AS grossSales,
  o.discounts, o.tax, o.shipping, o.total, o.current_total AS currentTotal, o.refunded, o.financial_status AS paymentStatus,
  o.fulfillment_status AS fulfillmentStatus, o.cancelled_at AS cancelledAt, o.cancel_reason AS cancelReason, o.channel, o.source_name AS source`;

export function listOrders(shop, { startDate, endDate }, { filter = 'all', limit = 25, offset = 0 } = {}) {
  const filters = {
    all: '1=1', cancelled: 'o.cancelled_at IS NOT NULL', refunded: "o.refunded > 0",
    unfulfilled: "o.cancelled_at IS NULL AND o.fulfillment_status IN ('UNFULFILLED','PARTIALLY_FULFILLED')",
    pending: "o.financial_status IN ('PENDING','AUTHORIZED','PARTIALLY_PAID')"
  };
  const clause = filters[filter] || filters.all;
  const base = `FROM orders o WHERE o.shop = ? AND o.test = 0 AND o.local_date BETWEEN ? AND ? AND ${clause}`;
  const total = db.prepare(`SELECT COUNT(*) AS count ${base}`).get(shop, startDate, endDate).count;
  const rows = db.prepare(`SELECT ${ORDER_COLUMNS} ${base} ORDER BY o.processed_at DESC LIMIT ? OFFSET ?`).all(shop, startDate, endDate, limit, offset);
  const items = db.prepare('SELECT title, variant_title AS variant, sku, quantity FROM order_line_items WHERE order_id = ?');
  return { total, limit, offset, orders: rows.map((row) => ({ ...row, items: items.all(row.id) })) };
}

export function refundList(shop, { startDate, endDate }, limit = 25) {
  return db.prepare(`SELECT r.id, r.created_at AS createdAt, r.local_date AS date, r.amount, o.name AS orderName, o.customer_name AS customer, o.financial_status AS paymentStatus
    FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.shop = ? AND o.test = 0 AND r.local_date BETWEEN ? AND ? ORDER BY r.created_at DESC LIMIT ?`).all(shop, startDate, endDate, limit)
    .map((row) => ({ ...row, amount: round(row.amount) }));
}

export function topCustomers(shop, { startDate, endDate }, limit = 10) {
  return db.prepare(`SELECT o.customer_id AS id, COALESCE(c.display_name, o.customer_name) AS name, COUNT(*) AS orders, SUM(o.total) AS spend,
      c.number_of_orders AS lifetimeOrders, c.amount_spent AS lifetimeSpend, c.created_at AS customerSince, c.last_order_at AS lastOrderAt
    FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE ${SALES_WHERE} AND o.customer_id IS NOT NULL
    GROUP BY o.customer_id ORDER BY spend DESC LIMIT ?`).all(shop, startDate, endDate, limit)
    .map((row) => ({ ...row, spend: round(row.spend), lifetimeSpend: round(row.lifetimeSpend), averageOrderValue: round(row.spend / row.orders) }));
}

export function productTable(shop, { startDate, endDate }, { limit = 50, offset = 0, q = '' } = {}) {
  const search = `%${q.toLowerCase()}%`;
  const rows = db.prepare(`SELECT p.id, p.title, p.vendor, p.product_type AS productType, p.status, p.created_at AS createdAt, p.updated_at AS updatedAt,
      p.total_inventory AS inventory, (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS variants,
      (SELECT MIN(price) FROM variants v WHERE v.product_id = p.id) AS minPrice, (SELECT MAX(price) FROM variants v WHERE v.product_id = p.id) AS maxPrice,
      COALESCE(s.units, 0) AS unitsSold, COALESCE(s.revenue, 0) AS revenue
    FROM products p LEFT JOIN (SELECT li.product_id, SUM(li.quantity) AS units, SUM(li.gross - li.discount) AS revenue
      FROM order_line_items li JOIN orders o ON o.id = li.order_id WHERE ${SALES_WHERE} GROUP BY li.product_id) s ON s.product_id = p.id
    WHERE p.shop = ? AND (lower(p.title) LIKE ? OR lower(COALESCE(p.vendor,'')) LIKE ?)
    ORDER BY revenue DESC, p.title LIMIT ? OFFSET ?`).all(shop, startDate, endDate, shop, search, search, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM products WHERE shop = ? AND (lower(title) LIKE ? OR lower(COALESCE(vendor,'')) LIKE ?)`).get(shop, search, search).count;
  return { total, limit, offset, products: rows.map((row) => ({ ...row, revenue: round(row.revenue) })) };
}

export function inventoryTable(shop, { threshold = 5, limit = 50, q = '' } = {}) {
  const search = `%${q.toLowerCase()}%`;
  const rows = db.prepare(`SELECT v.id AS variantId, p.title AS product, v.title AS variant, v.sku, l.name AS location, il.available, il.updated_at AS updatedAt
    FROM inventory_levels il JOIN variants v ON v.inventory_item_id = il.inventory_item_id JOIN products p ON p.id = v.product_id
    LEFT JOIN locations l ON l.id = il.location_id
    WHERE il.shop = ? AND v.tracked = 1 AND p.status = 'ACTIVE' AND il.available IS NOT NULL AND il.available <= ?
      AND (lower(p.title) LIKE ? OR lower(COALESCE(v.sku,'')) LIKE ?)
    ORDER BY il.available ASC, p.title LIMIT ?`).all(shop, threshold, search, search, limit);
  const totals = db.prepare(`SELECT COUNT(*) AS levels, SUM(CASE WHEN il.available <= 0 THEN 1 ELSE 0 END) AS outOfStock,
      SUM(CASE WHEN il.available > 0 AND il.available <= ? THEN 1 ELSE 0 END) AS low, SUM(il.available) AS unitsAvailable
    FROM inventory_levels il JOIN variants v ON v.inventory_item_id = il.inventory_item_id JOIN products p ON p.id = v.product_id
    WHERE il.shop = ? AND v.tracked = 1 AND p.status = 'ACTIVE'`).get(threshold, shop);
  const byLocation = db.prepare(`SELECT l.name AS location, SUM(il.available) AS unitsAvailable, COUNT(*) AS levels FROM inventory_levels il
    LEFT JOIN locations l ON l.id = il.location_id WHERE il.shop = ? GROUP BY il.location_id ORDER BY unitsAvailable DESC`).all(shop);
  return { threshold, totals, byLocation, lowStock: rows };
}
