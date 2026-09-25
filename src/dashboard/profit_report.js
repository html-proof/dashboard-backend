import { db } from '../database/db.js';
import { bucketKey, bucketSql } from './dates.js';
import { profitReport } from './profit.js';
import { salesReport, salesReportSeries, sessionsSeries } from '../shopify/analytics.js';

// "Your profit, line by line": one row per metric, one column per day/month plus the period total.
// A null cell means the value is unavailable (shown as "—"), never a confirmed zero.
const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const norm = (period, granularity) => (/^\d{4}-\d{2}-\d{2}$/.test(period) ? bucketKey(period, granularity) : period);

export async function buildProfitReport(shop, range, { currency }) {
  const granularity = range.granularity === 'month' ? 'month' : 'day';
  const r = { ...range, granularity };
  const [salesTotal, salesRows, sessionTotalRows] = await Promise.all([
    salesReport(shop, r.startDate, r.endDate).catch(() => null),
    salesReportSeries(shop, r).catch(() => null),
    sessionsSeries(shop, r).catch(() => null)
  ]);
  const sales = new Map((salesRows || []).map((row) => [norm(row.period, granularity), row]));
  const sessions = new Map((sessionTotalRows || []).map((row) => [norm(row.period, granularity), row]));

  // Periods: every bucket in the range, in order.
  const periods = [];
  for (let day = r.startDate; day <= r.endDate;) {
    const key = bucketKey(day, granularity);
    if (!periods.includes(key)) periods.push(key);
    const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); day = d.toISOString().slice(0, 10);
  }

  const bucket = bucketSql('o.local_date', granularity);
  const orders = new Map(db.prepare(`SELECT ${bucket} AS p, COUNT(*) AS n FROM orders o WHERE o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ? GROUP BY p`)
    .all(shop, r.startDate, r.endDate).map((row) => [row.p, row.n]));
  const newOrders = new Map(db.prepare(`WITH firsts AS (SELECT customer_id, MIN(local_date) AS first_date FROM orders WHERE shop = ? AND test = 0 AND customer_id IS NOT NULL GROUP BY customer_id)
    SELECT ${bucket} AS p, COUNT(*) AS n FROM orders o JOIN firsts f ON f.customer_id = o.customer_id
    WHERE o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ? AND f.first_date = o.local_date GROUP BY p`)
    .all(shop, shop, r.startDate, r.endDate).map((row) => [row.p, row.n]));

  const adRows = db.prepare(`SELECT ${bucketSql('date', granularity)} AS p, platform, SUM(amount) AS amount FROM ad_spend
    WHERE shop = ? AND date BETWEEN ? AND ? AND (currency IS NULL OR currency = ?) GROUP BY p, platform`).all(shop, r.startDate, r.endDate, currency);
  const recordedPlatforms = new Set(db.prepare('SELECT DISTINCT platform FROM ad_spend WHERE shop = ?').all(shop).map((row) => row.platform));
  const ad = (platforms) => (p) => {
    if (![...recordedPlatforms].some((x) => platforms.includes(x))) return null; // never recorded => unavailable, not zero
    return adRows.filter((row) => platforms.includes(row.platform) && (p === null || row.p === p)).reduce((s, row) => s + row.amount, 0);
  };

  const netSalesByPeriod = new Map([...sales].map(([k, v]) => [k, v.netSales]));
  const profit = profitReport(shop, r, { netSales: salesTotal?.netSales ?? null, netSalesByPeriod, shopCurrency: currency });
  const costs = new Map(profit.trend.map((t) => [t.period, t]));

  const s = (field) => (p) => (p === null ? salesTotal?.[field] ?? null : sales.get(p)?.[field] ?? (salesRows ? 0 : null));
  const conv = (p) => {
    const row = p === null ? { sessions: [...sessions.values()].reduce((a, x) => a + (x.sessions || 0), 0), completed: [...sessions.values()].reduce((a, x) => a + (x.completed || 0), 0) } : sessions.get(p);
    return sessionTotalRows && row?.sessions ? row.completed / row.sessions : null;
  };
  const cost = (field, configuredKey) => (p) => (configuredKey && !profit.configured[configuredKey] ? null : p === null ? profit[field] : costs.get(p)?.[field] ?? 0);
  const others = ['tiktok', 'pinterest', 'microsoft', 'other'];

  const sections = [
    { title: 'Revenue', source: 'Shopify Analytics sales report', rows: [
      ['Gross sales', s('grossSales'), 'money'], ['Discounts', s('discounts'), 'money'], ['Returns', s('returns'), 'money'],
      ['Net sales, excl. tax', s('netSales'), 'money', true], ['Tax collected', s('taxes'), 'money'], ['Shipping charged', s('shipping'), 'money'],
      ['Total sales', s('totalSales'), 'money']
    ] },
    { title: 'Store performance', source: 'Shopify Admin API orders · Shopify Analytics sessions', rows: [
      ['Orders', (p) => (p === null ? [...orders.values()].reduce((a, b) => a + b, 0) : orders.get(p) ?? 0), 'count'],
      ['New customer orders', (p) => (p === null ? [...newOrders.values()].reduce((a, b) => a + b, 0) : newOrders.get(p) ?? 0), 'count'],
      ['Sessions', (p) => (!sessionTotalRows ? null : p === null ? [...sessions.values()].reduce((a, x) => a + (x.sessions || 0), 0) : sessions.get(p)?.sessions ?? 0), 'count'],
      ['Conversion rate', conv, 'percent'],
      ['Average order value, excl. tax', s('averageOrderValue'), 'money']
    ] },
    { title: 'Advertising', source: 'Meta Marketing API and recorded ad spend', rows: [
      ['Meta ad spend', ad(['meta']), 'money'], ['Google ad spend', ad(['google']), 'money'], ['Other advertising spend', ad(others), 'money']
    ] },
    { title: 'Costs', source: 'Shopify “Cost per item” and payment fees · recorded ad spend, fixed costs & labour', rows: [
      ['Product costs', cost('productCosts', 'productCosts'), 'money'], ['Payment fees', cost('paymentFees'), 'money'], ['Advertising', cost('adSpend', 'adSpend'), 'money'],
      ['Fixed costs', cost('fixedCosts', 'fixedCosts'), 'money'], ['Labour', cost('labour', 'labour'), 'money'],
      ['Total expenses', (p) => (p === null ? profit.totalExpenses : costs.get(p)?.expenses ?? 0), 'money', true]
    ] },
    { title: 'Profit', source: 'Net sales excl. tax − total expenses', rows: [
      ['Operating profit', (p) => (p === null ? profit.operatingProfit : costs.get(p)?.profit ?? null), 'money', true],
      ['Profit margin', (p) => {
        const net = p === null ? profit.netSales : sales.get(p)?.netSales; const pr = p === null ? profit.operatingProfit : costs.get(p)?.profit;
        return net > 0 && pr != null ? pr / net : null;
      }, 'percent']
    ] }
  ];

  return {
    granularity, periods,
    sections: sections.map((section) => ({
      title: section.title, source: section.source,
      rows: section.rows.map(([label, fn, format, strong]) => ({
        label, format, strong: Boolean(strong),
        total: format === 'percent' ? fn(null) : round(fn(null)),
        values: periods.map((p) => (format === 'percent' ? fn(p) : round(fn(p))))
      }))
    })),
    missing: profit.missing, warnings: profit.warnings, productCostCoverage: profit.productCostCoverage,
    reportAvailable: Boolean(salesTotal)
  };
}
