import { db } from '../database/db.js';
import { isComplete } from '../shopify/sync.js';

// Data-driven "worth your attention" items. Each insight is emitted only when the underlying
// Shopify data supports it; there are no canned messages.
const pctChange = (current, previous) => (previous ? (current - previous) / Math.abs(previous) : null);

export function buildInsights(shop, range, { report, previousReport, sales, funnel, money, profitability: p }) {
  const items = [];

  if (p?.available && p.totalExpenses > 0 && p.operatingProfit < 0) {
    items.push({
      severity: 'warning', target: 'costs', title: 'Your margin needs attention',
      body: `Expenses (${money(p.totalExpenses)}) exceed net sales (${money(p.netSales)}) by ${money(-p.operatingProfit)} over this period.${p.missing.length ? ` Not yet included: ${p.missing.join(', ')}.` : ''}`,
      action: 'Review costs'
    });
  }
  if (p?.productCostCoverage != null && p.productCostCoverage < 0.95 && p.uncoveredUnits > 0) {
    items.push({
      severity: 'info', target: 'costs', title: 'Some products have no cost price',
      body: `${p.uncoveredUnits} unit(s) sold in this period have no "Cost per item" in Shopify, so ${((1 - p.productCostCoverage) * 100).toFixed(0)}% of product revenue has no product cost. Add costs in Shopify to make profit complete.`,
      action: 'See which products'
    });
  }

  if (report?.netSales != null && previousReport?.netSales != null && previousReport.netSales > 0) {
    const change = pctChange(report.netSales, previousReport.netSales);
    if (Math.abs(change) >= 0.1) {
      items.push({
        severity: change < 0 ? 'warning' : 'positive', target: 'sales',
        title: change < 0 ? 'Net sales are down' : 'Net sales are up',
        body: `Net sales were ${money(report.netSales)} for this period, ${Math.abs(change * 100).toFixed(0)}% ${change < 0 ? 'lower' : 'higher'} than the previous ${range.days} days (${money(previousReport.netSales)}).`,
        action: 'View sales'
      });
    }
  }

  const stale = db.prepare(`SELECT COUNT(*) AS n, MIN(processed_at) AS oldest FROM orders WHERE shop = ? AND test = 0 AND cancelled_at IS NULL
    AND financial_status = 'PAID' AND fulfillment_status IN ('UNFULFILLED','PARTIALLY_FULFILLED') AND processed_at < ?`).get(shop, new Date(Date.now() - 3 * 86_400_000).toISOString());
  if (stale.n > 0) {
    items.push({
      severity: 'warning', target: 'orders', title: 'Orders waiting to ship',
      body: `${stale.n} paid order${stale.n === 1 ? ' is' : 's are'} still unfulfilled after more than 3 days. The oldest was placed ${new Date(stale.oldest).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}.`,
      action: 'View orders'
    });
  }

  if (isComplete(shop, 'inventory')) {
    const stock = db.prepare(`SELECT COUNT(DISTINCT v.id) AS low FROM inventory_levels il JOIN variants v ON v.inventory_item_id = il.inventory_item_id
      JOIN products p ON p.id = v.product_id
      JOIN order_line_items li ON li.variant_id = v.id JOIN orders o ON o.id = li.order_id
      WHERE il.shop = ? AND v.tracked = 1 AND p.status = 'ACTIVE' AND il.available <= 5 AND o.local_date BETWEEN ? AND ? AND o.test = 0`).get(shop, range.startDate, range.endDate);
    if (stock.low > 0) {
      items.push({
        severity: 'warning', target: 'inventory', title: 'Best sellers running low',
        body: `${stock.low} variant${stock.low === 1 ? '' : 's'} sold in this period ${stock.low === 1 ? 'has' : 'have'} 5 or fewer units available.`,
        action: 'Review inventory'
      });
    }
  }

  if (sales.totalSales > 0 && sales.refunds / sales.totalSales >= 0.05) {
    items.push({
      severity: 'warning', target: 'refunds', title: 'Refunds are high',
      body: `Refunds totalled ${money(sales.refunds)} across ${sales.refundCount} refund${sales.refundCount === 1 ? '' : 's'}, equal to ${((sales.refunds / sales.totalSales) * 100).toFixed(1)}% of order revenue.`,
      action: 'View refunds'
    });
  }

  const steps = funnel?.steps;
  const checkout = steps?.find((s) => s.key === 'checkout')?.value; const completed = steps?.find((s) => s.key === 'completed')?.value;
  if (checkout > 0 && completed != null) {
    const abandoned = checkout - completed;
    if (abandoned / checkout >= 0.3) {
      items.push({
        severity: 'info', target: 'funnel', title: 'Checkout drop-off',
        body: `${abandoned} of ${checkout} sessions that reached checkout did not complete it (${((abandoned / checkout) * 100).toFixed(0)}%), according to Shopify Analytics.`,
        action: 'View funnel'
      });
    }
  }

  return items.slice(0, 4);
}
