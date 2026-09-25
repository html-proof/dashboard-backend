import { db } from '../database/db.js';
import { addDays, bucketKey } from './dates.js';
import { hasShifts, labourMethod, shiftCostsByDay } from './staff.js';

// Profit = Shopify net sales (excl. tax) − product costs − ad spend − fixed costs − labour.
// Inputs come from: Shopify "Cost per item" (product costs), ad platform APIs or manual entries (ad spend),
// and costs the business enters (fixed/labour). Nothing is estimated: a missing input is reported as missing.

export const COST_CATEGORIES = ['fixed', 'labour'];
export const FIXED_SUBCATEGORIES = ['operating', 'people', 'software', 'advertising', 'other'];
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'yearly', 'one_off'];
export const AD_PLATFORMS = ['meta', 'google', 'tiktok', 'pinterest', 'microsoft', 'other'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round = (v) => (v == null ? null : Math.round(v * 100) / 100);

export class ValidationError extends Error { constructor(message) { super(message); this.category = 'invalid_input'; } }

function need(condition, message) { if (!condition) throw new ValidationError(message); }
const validDate = (value) => DATE.test(value || '') && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

// ---- fixed & labour costs ------------------------------------------------------------------
export function listCosts(shop) {
  return db.prepare('SELECT id, name, category, subcategory, amount, frequency, start_date AS startDate, end_date AS endDate, created_at AS createdAt FROM costs WHERE shop = ? ORDER BY category, name').all(shop);
}

export function addCost(shop, body) {
  const name = String(body?.name || '').trim().slice(0, 120);
  const amount = Number(body?.amount);
  need(name, 'Name is required.');
  need(COST_CATEGORIES.includes(body?.category), `category must be one of: ${COST_CATEGORIES.join(', ')}`);
  const subcategory = body.category === 'labour' ? 'people' : (body.subcategory || 'other');
  need(FIXED_SUBCATEGORIES.includes(subcategory), `subcategory must be one of: ${FIXED_SUBCATEGORIES.join(', ')}`);
  need(FREQUENCIES.includes(body?.frequency), `frequency must be one of: ${FREQUENCIES.join(', ')}`);
  need(Number.isFinite(amount) && amount >= 0 && amount < 1e9, 'amount must be a positive number.');
  need(validDate(body?.startDate), 'startDate must be YYYY-MM-DD.');
  need(!body?.endDate || (validDate(body.endDate) && body.endDate >= body.startDate), 'endDate must be YYYY-MM-DD on or after startDate.');
  const result = db.prepare('INSERT INTO costs (shop, name, category, subcategory, amount, frequency, start_date, end_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(shop, name, body.category, subcategory, amount, body.frequency, body.startDate, body.endDate || null, new Date().toISOString());
  return { id: Number(result.lastInsertRowid) };
}

export function deleteCost(shop, id) {
  return Number(db.prepare('DELETE FROM costs WHERE shop = ? AND id = ?').run(shop, id).changes) > 0;
}

// Amount of a recurring cost that falls on one calendar day.
export function dailyShare(cost, day) {
  if (day < cost.start_date || (cost.end_date && day > cost.end_date)) return 0;
  switch (cost.frequency) {
    case 'daily': return cost.amount;
    case 'weekly': return cost.amount / 7;
    case 'monthly': { const d = new Date(`${day}T00:00:00Z`); return cost.amount / new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); }
    case 'yearly': { const y = Number(day.slice(0, 4)); return cost.amount / ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365); }
    case 'one_off': return day === cost.start_date ? cost.amount : 0;
    default: return 0;
  }
}

// ---- ad spend ------------------------------------------------------------------------------
export function listAdSpend(shop, { startDate, endDate }) {
  const entries = db.prepare(`SELECT platform, source, entry_id AS entryId, MIN(date) AS startDate, MAX(date) AS endDate, SUM(amount) AS amount, MAX(currency) AS currency
    FROM ad_spend WHERE shop = ? AND date BETWEEN ? AND ? GROUP BY platform, source, entry_id ORDER BY startDate DESC`).all(shop, startDate, endDate);
  return entries.map((entry) => ({ ...entry, amount: round(entry.amount) }));
}

// Manual entry. A single date is stored as-is; a multi-day total (e.g. an invoice for the month) is spread
// evenly across its days and labelled "allocated" so it is never mistaken for platform-reported daily spend.
export function addManualAdSpend(shop, body, currency) {
  const amount = Number(body?.amount);
  need(AD_PLATFORMS.includes(body?.platform), `platform must be one of: ${AD_PLATFORMS.join(', ')}`);
  need(Number.isFinite(amount) && amount >= 0 && amount < 1e9, 'amount must be a positive number.');
  need(validDate(body?.startDate), 'startDate must be YYYY-MM-DD.');
  const endDate = body.endDate || body.startDate;
  need(validDate(endDate) && endDate >= body.startDate, 'endDate must be on or after startDate.');
  const days = []; for (let d = body.startDate; d <= endDate; d = addDays(d, 1)) days.push(d);
  need(days.length <= 400, 'A single entry can cover at most 400 days.');
  const entryId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const insert = db.prepare('INSERT INTO ad_spend (shop, platform, date, amount, currency, source, entry_id, updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try { for (const day of days) insert.run(shop, body.platform, day, amount / days.length, currency, days.length > 1 ? 'manual_allocated' : 'manual', entryId, now); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
  return { entryId, days: days.length };
}

export function deleteAdSpendEntry(shop, entryId) {
  return Number(db.prepare("DELETE FROM ad_spend WHERE shop = ? AND entry_id = ? AND source LIKE 'manual%'").run(shop, String(entryId)).changes) > 0;
}

export function saveApiAdSpend(shop, platform, rows, currency) {
  const upsert = db.prepare(`INSERT INTO ad_spend (shop, platform, date, amount, currency, source, entry_id, updated_at) VALUES (?,?,?,?,?,'api','api',?)
    ON CONFLICT(shop, platform, date, source, entry_id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, updated_at = excluded.updated_at`);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try { for (const row of rows) upsert.run(shop, platform, row.date, row.amount, currency, now); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

// ---- profit --------------------------------------------------------------------------------
const SALES_WHERE = 'o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ?';

function productCostsByDay(shop, startDate, endDate) {
  const rows = db.prepare(`SELECT o.local_date AS day,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.quantity * v.unit_cost ELSE 0 END) AS cost,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.gross - li.discount ELSE 0 END) AS coveredRevenue,
      SUM(li.gross - li.discount) AS revenue,
      SUM(CASE WHEN v.unit_cost IS NULL THEN li.quantity ELSE 0 END) AS uncoveredUnits
    FROM order_line_items li JOIN orders o ON o.id = li.order_id LEFT JOIN variants v ON v.id = li.variant_id
    WHERE ${SALES_WHERE} GROUP BY o.local_date`).all(shop, startDate, endDate);
  return new Map(rows.map((row) => [row.day, row]));
}

export function paymentFeesByDay(shop, startDate, endDate) {
  return new Map(db.prepare(`SELECT local_date AS day, SUM(COALESCE(payment_fees, 0)) AS fees FROM orders
    WHERE shop = ? AND test = 0 AND local_date BETWEEN ? AND ? GROUP BY local_date`).all(shop, startDate, endDate).map((r) => [r.day, r.fees]));
}

export function missingCostProducts(shop, { startDate, endDate }, limit = 10) {
  return db.prepare(`SELECT li.title, li.variant_title AS variant, li.sku, SUM(li.quantity) AS units, SUM(li.gross - li.discount) AS revenue
    FROM order_line_items li JOIN orders o ON o.id = li.order_id LEFT JOIN variants v ON v.id = li.variant_id
    WHERE ${SALES_WHERE} AND v.unit_cost IS NULL GROUP BY COALESCE(li.variant_id, li.title) ORDER BY revenue DESC LIMIT ?`).all(shop, startDate, endDate, limit)
    .map((row) => ({ ...row, revenue: round(row.revenue) }));
}

/**
 * @param netSalesByPeriod Map period → Shopify net sales (from the ShopifyQL report), keyed by bucketKey.
 */
export function profitReport(shop, range, { netSales, netSalesByPeriod, shopCurrency }) {
  const { startDate, endDate, granularity } = range;
  const product = productCostsByDay(shop, startDate, endDate);
  const fees = paymentFeesByDay(shop, startDate, endDate);
  // Labour comes from exactly one source so payroll is never counted twice (see Staff & hours).
  const method = labourMethod(shop);
  const shiftCosts = method === 'timesheets' ? shiftCostsByDay(shop, startDate, endDate) : null;
  const ads = db.prepare(`SELECT date, platform, source, SUM(amount) AS amount, MAX(currency) AS currency FROM ad_spend WHERE shop = ? AND date BETWEEN ? AND ? GROUP BY date, platform, source`).all(shop, startDate, endDate);
  const costs = db.prepare('SELECT * FROM costs WHERE shop = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)').all(shop, endDate, startDate);
  const foreignCurrency = [...new Set(ads.map((a) => a.currency).filter((c) => c && c !== shopCurrency))];

  const byPeriod = new Map();
  const totals = { paymentFees: 0, productCosts: 0, adSpend: 0, fixedCosts: 0, labour: 0, coveredRevenue: 0, lineRevenue: 0, uncoveredUnits: 0 };
  const adByPlatform = {};
  const adsByDay = new Map();
  for (const a of ads) {
    if (a.currency && a.currency !== shopCurrency) continue; // never add spend in another currency without conversion
    adsByDay.set(a.date, (adsByDay.get(a.date) || 0) + a.amount);
    adByPlatform[a.platform] = (adByPlatform[a.platform] || 0) + a.amount;
  }
  for (let day = startDate; day <= endDate; day = addDays(day, 1)) {
    const p = product.get(day) || {};
    const fixed = costs.filter((c) => c.category === 'fixed').reduce((s, c) => s + dailyShare(c, day), 0);
    const labour = shiftCosts ? shiftCosts.get(day) || 0 : costs.filter((c) => c.category === 'labour').reduce((s, c) => s + dailyShare(c, day), 0);
    const ad = adsByDay.get(day) || 0;
    const fee = fees.get(day) || 0;
    totals.paymentFees += fee;
    totals.productCosts += p.cost || 0; totals.adSpend += ad; totals.fixedCosts += fixed; totals.labour += labour;
    totals.coveredRevenue += p.coveredRevenue || 0; totals.lineRevenue += p.revenue || 0; totals.uncoveredUnits += p.uncoveredUnits || 0;
    const key = bucketKey(day, granularity);
    const bucket = byPeriod.get(key) || { period: key, productCosts: 0, paymentFees: 0, adSpend: 0, fixedCosts: 0, labour: 0 };
    bucket.productCosts += p.cost || 0; bucket.paymentFees += fee; bucket.adSpend += ad; bucket.fixedCosts += fixed; bucket.labour += labour;
    byPeriod.set(key, bucket);
  }

  const configured = {
    productCosts: totals.lineRevenue === 0 || totals.coveredRevenue > 0,
    adSpend: db.prepare('SELECT 1 FROM ad_spend WHERE shop = ? LIMIT 1').get(shop) != null,
    fixedCosts: costs.some((c) => c.category === 'fixed') || db.prepare("SELECT 1 FROM costs WHERE shop = ? AND category = 'fixed' LIMIT 1").get(shop) != null,
    labour: method === 'timesheets' ? hasShifts(shop) : costs.some((c) => c.category === 'labour') || db.prepare("SELECT 1 FROM costs WHERE shop = ? AND category = 'labour' LIMIT 1").get(shop) != null
  };
  const expenses = totals.productCosts + totals.paymentFees + totals.adSpend + totals.fixedCosts + totals.labour;
  const available = netSales != null;
  const profit = available ? netSales - expenses : null;
  const missing = Object.entries(configured).filter(([, ok]) => !ok).map(([key]) => ({ productCosts: 'product costs', adSpend: 'ad spend', fixedCosts: 'fixed costs', labour: 'labour' }[key]));

  return {
    available,
    reason: available ? null : 'Shopify net sales unavailable for this range',
    netSales: round(netSales),
    productCosts: round(totals.productCosts), paymentFees: round(totals.paymentFees), adSpend: round(totals.adSpend), fixedCosts: round(totals.fixedCosts), labour: round(totals.labour),
    totalExpenses: round(expenses),
    operatingProfit: round(profit),
    profitMargin: available && netSales > 0 ? Math.round((profit / netSales) * 10_000) / 10_000 : null,
    adSpendByPlatform: Object.fromEntries(Object.entries(adByPlatform).map(([k, v]) => [k, round(v)])),
    productCostCoverage: totals.lineRevenue > 0 ? Math.round((totals.coveredRevenue / totals.lineRevenue) * 1000) / 1000 : null,
    uncoveredUnits: totals.uncoveredUnits,
    configured, missing, labourMethod: method,
    warnings: [
      ...(missing.length ? [`Not included (not set up): ${missing.join(', ')}.`] : []),
      ...(totals.lineRevenue > 0 && totals.coveredRevenue < totals.lineRevenue ? [`${totals.uncoveredUnits} unit(s) sold have no Shopify "Cost per item", so their product cost is not included.`] : []),
      ...(foreignCurrency.length ? [`Ad spend in ${foreignCurrency.join(', ')} is excluded (differs from store currency ${shopCurrency}).`] : [])
    ],
    definitions: {
      operatingProfit: 'Shopify net sales (excl. tax, after discounts and returns) − product costs − payment fees − ad spend − fixed costs − labour.',
      paymentFees: 'Processing fees Shopify reports on transactions (Shopify Payments). PayPal, Afterpay and other external gateways are not reported by Shopify.',
      productCosts: 'Units sold × the variant\'s current Shopify "Cost per item". Shopify does not keep historical cost per order.',
      fixedCosts: 'Entered recurring costs spread evenly per day (monthly ÷ days in month, etc.).'
    },
    trend: [...byPeriod.values()].map((b) => {
      const sales = netSalesByPeriod?.get(b.period) ?? null;
      const exp = b.productCosts + b.paymentFees + b.adSpend + b.fixedCosts + b.labour;
      return { period: b.period, netSales: round(sales), expenses: round(exp), productCosts: round(b.productCosts), paymentFees: round(b.paymentFees), adSpend: round(b.adSpend), fixedCosts: round(b.fixedCosts), labour: round(b.labour), profit: sales == null ? null : round(sales - exp) };
    })
  };
}
