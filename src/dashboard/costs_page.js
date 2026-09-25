import { db } from '../database/db.js';
import { addDays } from './dates.js';
import { dailyShare, FIXED_SUBCATEGORIES, listCosts, paymentFeesByDay } from './profit.js';
import { hasShifts, labourMethod, shiftCostsByDay } from './staff.js';

// Costs page: fixed costs (entered), timesheet labour (entered) and variable costs (from Shopify).
// A null amount means "not reported / not set up", never a confirmed zero.
const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const SALES_WHERE = 'o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ?';

export function costsOverview(shop, { startDate, endDate }) {
  const days = []; for (let d = startDate; d <= endDate; d = addDays(d, 1)) days.push(d);

  // Entered costs, allocated to the selected days.
  const entries = listCosts(shop).map((c) => {
    const row = { ...c, start_date: c.startDate, end_date: c.endDate };
    return { ...c, periodTotal: round(days.reduce((s, d) => s + dailyShare(row, d), 0)) };
  });
  const fixed = entries.filter((c) => c.category === 'fixed');
  const labour = entries.filter((c) => c.category === 'labour');
  const fixedByCategory = FIXED_SUBCATEGORIES.map((key) => ({
    category: key, total: fixed.length ? round(fixed.filter((c) => c.subcategory === key).reduce((s, c) => s + c.periodTotal, 0)) : null
  }));

  // Variable costs from Shopify.
  const product = db.prepare(`SELECT SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.quantity * v.unit_cost ELSE 0 END) AS cost,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.gross - li.discount ELSE 0 END) AS covered, SUM(li.gross - li.discount) AS revenue,
      SUM(li.quantity) AS units, SUM(CASE WHEN v.unit_cost IS NULL THEN li.quantity ELSE 0 END) AS uncoveredUnits
    FROM order_line_items li JOIN orders o ON o.id = li.order_id LEFT JOIN variants v ON v.id = li.variant_id WHERE ${SALES_WHERE}`).get(shop, startDate, endDate);
  const feesTotal = [...paymentFeesByDay(shop, startDate, endDate).values()].reduce((a, b) => a + b, 0);
  const feesSynced = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE shop = ? AND test = 0 AND local_date BETWEEN ? AND ? AND payment_fees IS NULL').get(shop, startDate, endDate).n === 0;
  const gateways = db.prepare(`SELECT COALESCE(gateways, 'none') AS gateway, COUNT(*) AS orders, SUM(total) AS sales, SUM(COALESCE(payment_fees, 0)) AS fees
    FROM orders WHERE shop = ? AND test = 0 AND local_date BETWEEN ? AND ? GROUP BY gateway ORDER BY sales DESC`).all(shop, startDate, endDate)
    .map((g) => ({ gateway: g.gateway, orders: g.orders, sales: round(g.sales), fees: round(g.fees), feesReported: g.fees > 0 || /shopify_payments/.test(g.gateway), effectiveRate: g.sales > 0 && g.fees > 0 ? Math.round((g.fees / g.sales) * 10_000) / 10_000 : null }));
  const unreportedGateways = gateways.filter((g) => !g.feesReported && g.gateway !== 'none' && !/manual|cash/i.test(g.gateway)).map((g) => g.gateway);

  const variableByCategory = [
    { category: 'product', total: round(product.cost ?? 0), source: 'Shopify “Cost per item” × units sold',
      note: product.revenue > 0 && product.covered < product.revenue ? `${product.uncoveredUnits} unit(s) have no cost price (${((product.covered / product.revenue) * 100).toFixed(0)}% of product sales covered)` : null },
    { category: 'payments', total: feesSynced ? round(feesTotal) : null, source: 'Processing fees reported by Shopify (Shopify Payments)',
      note: !feesSynced ? 'Fees still syncing from Shopify' : unreportedGateways.length ? `Not reported by Shopify: ${unreportedGateways.join(', ')} fees` : null },
    { category: 'fulfilment', total: null, source: 'Not available from the Shopify Admin API', note: 'Shipping label and 3PL costs are not reported by Shopify' },
    { category: 'other', total: null, source: 'Not set up', note: null }
  ];
  const variableTotal = variableByCategory.reduce((s, c) => s + (c.total || 0), 0);

  return {
    days: days.length,
    fixed: { total: fixed.length ? round(fixed.reduce((s, c) => s + c.periodTotal, 0)) : null, byCategory: fixedByCategory, entries: fixed },
    labour: labourMethod(shop) === 'timesheets'
      ? { method: 'timesheets', total: hasShifts(shop) ? round([...shiftCostsByDay(shop, startDate, endDate).values()].reduce((a, b) => a + b, 0)) : null, entries: labour }
      : { method: 'fixed_payroll', total: labour.length ? round(labour.reduce((s, c) => s + c.periodTotal, 0)) : null, entries: labour },
    variable: { total: round(variableTotal), byCategory: variableByCategory, gateways, productUnits: product.units ?? 0 }
  };
}
