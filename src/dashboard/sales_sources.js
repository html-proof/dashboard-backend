import { db } from '../database/db.js';
import { graphql } from '../shopify/client.js';
import { salesReport } from '../shopify/analytics.js';
import { tokenStatus } from '../auth/token_service.js';
import { metaStatus } from '../ads/meta.js';

// Sales by channel. Revenue comes from Shopify's sales report grouped by sales_channel (so channels sum to the
// store total and nothing is counted twice); orders, refunds and product costs come from synced Admin API orders.
const QUERY = `query Q($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { rows } } }`;
const num = (v) => (v == null || v === '' ? null : Number(v));
const round = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

async function shopifyql(shop, q) {
  const data = await graphql(shop, QUERY, { q }, { operation: 'shopifyql', expectedCost: 10 });
  if (data.shopifyqlQuery.parseErrors?.length) throw Object.assign(new Error(data.shopifyqlQuery.parseErrors.join('; ')), { category: 'shopifyql_error' });
  return data.shopifyqlQuery.tableData?.rows || [];
}

const SALES_WHERE = 'o.shop = ? AND o.test = 0 AND o.cancelled_at IS NULL AND o.local_date BETWEEN ? AND ?';

export async function salesSources(shop, { startDate, endDate }) {
  const [channelRows, dailyRows, total] = await Promise.all([
    shopifyql(shop, `FROM sales SHOW orders, gross_sales, discounts, returns, net_sales, total_sales GROUP BY sales_channel SINCE ${startDate} UNTIL ${endDate}`).catch((e) => ({ error: e })),
    shopifyql(shop, `FROM sales SHOW net_sales GROUP BY sales_channel TIMESERIES day SINCE ${startDate} UNTIL ${endDate}`).catch((e) => ({ error: e })),
    salesReport(shop, startDate, endDate).catch(() => null)
  ]);
  const reportAvailable = Array.isArray(channelRows);

  // Local per-channel figures from synced orders.
  const local = new Map(db.prepare(`SELECT COALESCE(o.channel, 'Unknown') AS channel, COUNT(*) AS orders, SUM(o.units) AS units FROM orders o WHERE ${SALES_WHERE} GROUP BY channel`)
    .all(shop, startDate, endDate).map((row) => [row.channel, row]));
  const refunds = new Map(db.prepare(`SELECT COALESCE(o.channel, 'Unknown') AS channel, COUNT(*) AS count, SUM(r.amount) AS amount FROM refunds r JOIN orders o ON o.id = r.order_id
    WHERE r.shop = ? AND o.test = 0 AND r.local_date BETWEEN ? AND ? GROUP BY channel`).all(shop, startDate, endDate).map((row) => [row.channel, row]));
  const costs = new Map(db.prepare(`SELECT COALESCE(o.channel, 'Unknown') AS channel,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.quantity * v.unit_cost ELSE 0 END) AS cost,
      SUM(CASE WHEN v.unit_cost IS NOT NULL THEN li.gross - li.discount ELSE 0 END) AS covered, SUM(li.gross - li.discount) AS revenue
    FROM order_line_items li JOIN orders o ON o.id = li.order_id LEFT JOIN variants v ON v.id = li.variant_id WHERE ${SALES_WHERE} GROUP BY channel`)
    .all(shop, startDate, endDate).map((row) => [row.channel, row]));

  const channels = reportAvailable ? channelRows.filter((row) => row.sales_channel) : [];
  const totalNet = channels.reduce((s, row) => s + (num(row.net_sales) || 0), 0);
  const sources = channels.map((row) => {
    const name = row.sales_channel; const c = costs.get(name); const net = num(row.net_sales);
    const coverage = c?.revenue > 0 ? c.covered / c.revenue : null;
    return {
      source: name, netRevenue: round(net), grossSales: round(num(row.gross_sales)), discounts: round(Math.abs(num(row.discounts) || 0)), returns: round(Math.abs(num(row.returns) || 0)),
      totalSales: round(num(row.total_sales)), mix: totalNet > 0 ? Math.round((net / totalNet) * 1000) / 1000 : null,
      orders: num(row.orders), localOrders: local.get(name)?.orders ?? 0, units: local.get(name)?.units ?? 0,
      refunds: round(refunds.get(name)?.amount ?? 0), refundCount: refunds.get(name)?.count ?? 0,
      directCosts: c ? round(c.cost) : null, costCoverage: coverage == null ? null : Math.round(coverage * 1000) / 1000,
      contribution: c && net != null ? round(net - c.cost) : null
    };
  }).sort((a, b) => (b.netRevenue || 0) - (a.netRevenue || 0));

  // Daily reconciliation: channel net sales per day vs Shopify's store-wide total.
  const days = new Map();
  if (Array.isArray(dailyRows)) {
    for (const row of dailyRows) {
      const day = days.get(row.day) || { date: row.day, channels: {}, sum: 0 };
      if (row.sales_channel) { day.channels[row.sales_channel] = round(num(row.net_sales)); day.sum += num(row.net_sales) || 0; }
      days.set(row.day, day);
    }
  }
  const dailyTotals = Array.isArray(dailyRows) ? await shopifyql(shop, `FROM sales SHOW net_sales, orders TIMESERIES day SINCE ${startDate} UNTIL ${endDate}`).catch(() => []) : [];
  const localDaily = new Map(db.prepare(`SELECT o.local_date AS d, COUNT(*) AS n FROM orders o WHERE ${SALES_WHERE} GROUP BY d`).all(shop, startDate, endDate).map((r) => [r.d, r.n]));
  const reconciliation = dailyTotals.map((row) => {
    const d = days.get(row.day) || { channels: {}, sum: 0 };
    const storeNet = num(row.net_sales);
    return {
      date: row.day, channels: d.channels, channelSum: round(d.sum), storeNet: round(storeNet),
      difference: storeNet == null ? null : round(d.sum - storeNet),
      shopifyOrders: num(row.orders), syncedOrders: localDaily.get(row.day) ?? 0
    };
  });

  return {
    reportAvailable, reason: reportAvailable ? null : `${channelRows.error?.category || 'error'}: ${channelRows.error?.message || ''}`,
    totals: {
      netRevenue: round(totalNet), storeNetRevenue: round(total?.netSales ?? null),
      difference: total?.netSales != null ? round(totalNet - total.netSales) : null,
      orders: sources.reduce((s, x) => s + (x.orders || 0), 0), refunds: round(sources.reduce((s, x) => s + x.refunds, 0)),
      directCosts: round(sources.reduce((s, x) => s + (x.directCosts || 0), 0)), contribution: round(sources.reduce((s, x) => s + (x.contribution || 0), 0))
    },
    sources, channelNames: sources.map((s) => s.source), reconciliation,
    settings: sourceSettings(shop), integrations: integrations(shop)
  };
}

// Every channel that has ever produced an order, from the full synced history.
function sourceSettings(shop) {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  return db.prepare(`SELECT COALESCE(channel, 'Unknown') AS source, GROUP_CONCAT(DISTINCT source_name) AS sourceNames, COUNT(*) AS lifetimeOrders,
      MIN(local_date) AS firstOrder, MAX(local_date) AS lastOrder, SUM(total) AS lifetimeTotal
    FROM orders WHERE shop = ? AND test = 0 GROUP BY source ORDER BY lifetimeOrders DESC`).all(shop)
    .map((row) => ({ ...row, lifetimeTotal: round(row.lifetimeTotal), status: row.lastOrder >= cutoff ? 'Active' : 'Inactive (no orders in 30 days)', reporting: 'Shopify (imported automatically)' }));
}

function integrations(shop) {
  const token = tokenStatus(shop);
  const scopes = token.scopes || [];
  const meta = metaStatus(shop);
  return [
    { name: 'Shopify Admin API', purpose: 'Orders, customers, products, inventory, refunds', status: token.stored && !token.revoked ? 'Connected' : 'Not connected', detail: token.stored ? `${scopes.length} scopes · ${token.grantType}` : 'Connect at /shopify/auth' },
    { name: 'Shopify Analytics (ShopifyQL)', purpose: 'Sales report, channel split, sessions', status: scopes.includes('read_reports') ? 'Connected' : 'Missing read_reports scope', detail: 'Revenue and channel figures match Shopify admin reports' },
    { name: 'Shopify webhooks', purpose: 'Instant updates', status: String(process.env.APP_URL || '').startsWith('https://') ? 'Registered' : 'Not active', detail: String(process.env.APP_URL || '').startsWith('https://') ? 'Pushes changes as they happen' : 'Needs a public HTTPS APP_URL; 10-second sync is used instead' },
    { name: 'Meta Ads', purpose: 'Ad spend for profit', status: meta.configured ? (meta.error ? 'Error' : 'Connected') : 'Not connected', detail: meta.configured ? (meta.error || `Last sync ${meta.lastSyncAt || 'pending'}`) : 'Set META_AD_ACCOUNT_ID and META_ACCESS_TOKEN' },
    { name: 'Sales outside Shopify', purpose: 'Marketplaces, invoices or tills not in Shopify', status: 'None recorded', detail: 'All revenue shown comes from Shopify channels' }
  ];
}
