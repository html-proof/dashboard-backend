import { db, localDate, transaction } from '../database/db.js';
import { graphql } from '../shopify/client.js';
import { getStore } from '../shopify/store.js';
import { ValidationError } from './profit.js';

// Annual plan. Defaults come from Shopify history; every field can be overridden. Planning figures are
// scenarios, clearly separated from actual revenue (which always comes from Shopify's sales report).
const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const need = (ok, message) => { if (!ok) throw new ValidationError(message); };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

async function monthlyNetSales(shop, year) {
  const data = await graphql(shop, `query Q($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { rows } } }`,
    { q: `FROM sales SHOW net_sales TIMESERIES month SINCE ${year}-01-01 UNTIL ${year}-12-31` }, { operation: 'shopifyql', expectedCost: 10 });
  if (data.shopifyqlQuery.parseErrors?.length) throw Object.assign(new Error(data.shopifyqlQuery.parseErrors.join('; ')), { category: 'shopifyql_error' });
  const map = new Map();
  for (const row of data.shopifyqlQuery.tableData?.rows || []) map.set(Number(String(row.month).slice(5, 7)), Number(row.net_sales));
  return map;
}

// Measured defaults from the last 12 months of synced Shopify data.
function measuredDefaults(shop, today, netSalesLast12) {
  const from = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const row = db.prepare(`SELECT SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.quantity * v.unit_cost END) AS cost,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.quantity END) AS costedUnits,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.gross - li.discount END) AS covered, SUM(li.gross - li.discount) AS revenue
    FROM order_line_items li JOIN orders o ON o.id = li.order_id LEFT JOIN variants v ON v.id = li.variant_id
    WHERE o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ?`).get(shop, from, today);
  const coverage = row.revenue > 0 ? row.covered / row.revenue : null;
  return {
    landedCost: row.costedUnits > 0 ? round(row.cost / row.costedUnits) : null,
    // Cost % is measured only over the sales that have a cost price, scaled to net sales, so missing costs don't lower it.
    costPct: netSalesLast12 > 0 && coverage > 0 ? Math.round((row.cost / (netSalesLast12 * coverage)) * 10_000) / 100 : null,
    coverage: coverage == null ? null : Math.round(coverage * 1000) / 1000,
    window: { from, to: today }
  };
}

export async function getPlan(shop, year) {
  need(Number.isInteger(year) && year >= 2000 && year <= 2100, 'year must be a four-digit year.');
  const tz = getStore(shop)?.iana_timezone || 'UTC';
  const today = localDate(new Date().toISOString(), tz);
  const [baseline, actual, thisYear, lastYear] = await Promise.all([
    monthlyNetSales(shop, year - 1).catch(() => null),
    monthlyNetSales(shop, year).catch(() => null),
    monthlyNetSales(shop, Number(today.slice(0, 4))).catch(() => null),
    monthlyNetSales(shop, Number(today.slice(0, 4)) - 1).catch(() => null)
  ]);
  // Net sales for the 12 months up to today, for the cost % default.
  const curMonth = Number(today.slice(5, 7));
  const netLast12 = thisYear && lastYear ? MONTHS.reduce((s, m) => s + (m <= curMonth ? thisYear.get(m) || 0 : lastYear.get(m) || 0), 0) : null;
  const measured = measuredDefaults(shop, today, netLast12);

  const firstOrder = db.prepare('SELECT MIN(local_date) AS d FROM orders WHERE shop = ? AND test = 0').get(shop)?.d;
  const plan = db.prepare('SELECT * FROM annual_plans WHERE shop = ? AND year = ?').get(shop, year);
  const saved = new Map(db.prepare('SELECT * FROM annual_plan_months WHERE shop = ? AND year = ?').all(shop, year).map((r) => [r.month, r]));
  const growth = plan?.growth_pct ?? null;
  const landedCost = plan?.landed_cost ?? measured.landedCost;
  const costPct = plan?.cost_pct ?? measured.costPct;

  const months = MONTHS.map((m) => {
    const s = saved.get(m) || {};
    const monthStart = `${year}-${pad(m)}-01`; const monthEnd = `${year}-${pad(m)}-${pad(daysIn(year, m))}`;
    // Shopify baseline only for months the store was trading in last year; otherwise unavailable.
    const priorMonthEnd = `${year - 1}-${pad(m)}-${pad(daysIn(year - 1, m))}`;
    const shopifyBaseline = baseline && firstOrder && firstOrder <= priorMonthEnd ? round(baseline.get(m) ?? 0) : null;
    const base = s.baseline ?? shopifyBaseline;
    const autoForecast = base != null && growth != null ? round(base * (1 + growth / 100)) : base != null ? round(base) : null;
    const forecast = s.forecast ?? autoForecast;
    const autoStock = forecast != null && costPct != null ? round(forecast * (costPct / 100)) : null;
    const stock = s.stock_budget ?? autoStock;
    const autoUnits = stock != null && landedCost > 0 ? Math.ceil(stock / landedCost) : null;
    const completedDays = today < monthStart ? 0 : today > monthEnd ? daysIn(year, m) : Number(today.slice(8, 10)) - 1;
    return {
      month: m, days: daysIn(year, m),
      baseline: base, baselineSource: s.baseline != null ? 'override' : shopifyBaseline != null ? 'shopify' : 'none', shopifyBaseline,
      theme: s.theme || '',
      forecast, forecastOverride: s.forecast ?? null, autoForecast,
      dailyTarget: forecast != null ? round(forecast / daysIn(year, m)) : null,
      actual: actual && completedDays > 0 ? round(actual.get(m) ?? 0) : null, completedDays,
      stockBudget: stock, stockOverride: s.stock_budget ?? null, autoStock,
      requiredUnits: s.required_units ?? autoUnits, unitsOverride: s.required_units ?? null, autoUnits,
      orderedUnits: s.ordered_units ?? null
    };
  });
  const sum = (key) => (months.some((m) => m[key] != null) ? round(months.reduce((a, m) => a + (m[key] || 0), 0)) : null);
  return {
    year, today, saved: Boolean(plan), updatedAt: plan?.updated_at || null,
    settings: { growthPct: growth, landedCost, costPct, landedCostSource: plan?.landed_cost != null ? 'override' : 'measured', costPctSource: plan?.cost_pct != null ? 'override' : 'measured' },
    measured, currency: getStore(shop)?.currency,
    totals: { revenueTarget: sum('forecast'), stockBudget: sum('stockBudget'), requiredUnits: sum('requiredUnits'), orderedUnits: sum('orderedUnits'), actual: sum('actual') },
    months, sourcesAvailable: { baseline: Boolean(baseline), actual: Boolean(actual) }
  };
}

const num = (v, { integer = false, min = 0, max = 1e10 } = {}) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  need(Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)), `Invalid number: ${v}`);
  return n;
};

export function savePlan(shop, body) {
  const year = Number(body?.year);
  need(Number.isInteger(year) && year >= 2000 && year <= 2100, 'year must be a four-digit year.');
  need(Array.isArray(body.months) && body.months.length <= 12, 'months must be a list of up to 12 months.');
  const growth = num(body.growthPct, { min: -100, max: 1000 });
  const landed = num(body.landedCost, { max: 1e6 });
  const costPct = num(body.costPct, { max: 100 });
  transaction(() => {
    db.prepare(`INSERT INTO annual_plans (shop, year, growth_pct, landed_cost, cost_pct, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(shop, year) DO UPDATE SET growth_pct=excluded.growth_pct, landed_cost=excluded.landed_cost, cost_pct=excluded.cost_pct, updated_at=excluded.updated_at`)
      .run(shop, year, growth, landed, costPct, new Date().toISOString());
    const upsert = db.prepare(`INSERT INTO annual_plan_months (shop, year, month, baseline, theme, forecast, stock_budget, required_units, ordered_units)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(shop, year, month) DO UPDATE SET baseline=excluded.baseline, theme=excluded.theme, forecast=excluded.forecast,
      stock_budget=excluded.stock_budget, required_units=excluded.required_units, ordered_units=excluded.ordered_units`);
    for (const m of body.months) {
      const month = Number(m.month);
      need(Number.isInteger(month) && month >= 1 && month <= 12, 'month must be 1-12.');
      upsert.run(shop, year, month, num(m.baseline), String(m.theme || '').slice(0, 120) || null, num(m.forecast), num(m.stockBudget),
        num(m.requiredUnits, { integer: true }), num(m.orderedUnits, { integer: true }));
    }
  });
  return { saved: true };
}
