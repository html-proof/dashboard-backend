// Live verification against the running backend + real Shopify. Prints PASS/FAIL per area and
// separates what Shopify returned from what needs extra permissions or custom tracking.
// Usage: BASE_URL=http://localhost:3000 npm run report
import { config } from '../src/config.js';
import { graphql } from '../src/shopify/client.js';

const BASE = process.env.BASE_URL || config.appUrl;
const shop = config.shopify.store;
const headers = config.dashboardApiKey ? { authorization: `Bearer ${config.dashboardApiKey}` } : {};
const results = [];
const fetched = []; const needsPermission = []; const notExposed = []; const needsTracking = [];

async function check(name, work) {
  try { const note = await work(); results.push([name, 'PASS', note]); } catch (error) { results.push([name, 'FAIL', error.message]); }
}
async function get(path) {
  const response = await fetch(`${BASE}${path}`, { headers });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path} → ${response.status} ${body.error || ''}`);
  return body;
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };

process.env.LOG_SILENT = '1';

await check('Shopify Authentication', async () => {
  const data = await graphql(shop, '{ currentAppInstallation { accessScopes { handle } } }');
  const scopes = data.currentAppInstallation.accessScopes.map((s) => s.handle);
  for (const scope of config.shopify.scopes.split(',')) if (!scopes.includes(scope)) needsPermission.push(scope);
  return `${scopes.length} scopes granted`;
});
const status = await get('/api/status').catch(() => null);
await check('Store Connection', async () => {
  assert(status?.store?.name, 'store not synced'); fetched.push('Store name, domains, currency, timezone, plan, locations');
  return `${status.store.name} (${status.store.currency}, ${status.store.iana_timezone})`;
});
const syncOf = (r) => status?.sync.resources.find((x) => x.resource === r);
const overview = await get('/api/dashboard/overview?preset=last_30_days').catch((e) => ({ error: e.message }));

await check('Orders', async () => {
  assert(syncOf('orders')?.complete, `orders sync incomplete: ${syncOf('orders')?.error || 'running'}`);
  const orders = await get('/api/dashboard/orders?preset=last_year&limit=1');
  const live = await graphql(shop, '{ ordersCount(limit: null) { count } }');
  fetched.push('Orders, line items, discounts, taxes, shipping, totals, payment/fulfillment/cancel status, channel, source');
  return `${syncOf('orders').record_count} synced; Shopify reports ${live.ordersCount.count}; ${orders.total} last year`;
});
await check('Products', async () => {
  assert(syncOf('products')?.complete && syncOf('variants')?.complete, 'product sync incomplete');
  fetched.push('Products, variants, SKU, price, vendor, type, status, dates, units sold, revenue');
  return `${syncOf('products').record_count} products, ${syncOf('variants').record_count} variants`;
});
await check('Customers', async () => {
  assert(syncOf('customers')?.complete, 'customer sync incomplete');
  const c = await get('/api/dashboard/customers?preset=last_30_days');
  fetched.push('Customer count, new/returning, order count, total spend, created date, last order date');
  return `${syncOf('customers').record_count} customers; ${c.summary.current.customersWhoOrdered} ordered in last 30 days`;
});
await check('Inventory', async () => {
  assert(syncOf('inventory')?.complete, `inventory sync incomplete: ${syncOf('inventory')?.error || 'running'}`);
  const inv = await get('/api/dashboard/inventory');
  fetched.push('Inventory levels per location, SKU, variant, available quantity');
  notExposed.push('Inventory change history (only current levels + live inventory_levels/update webhooks)');
  return `${inv.totals.levels} levels, ${inv.totals.low} low, ${inv.totals.outOfStock} out of stock`;
});
await check('Refunds', async () => {
  const r = await get('/api/dashboard/refunds?preset=last_year');
  fetched.push('Refunds (amount, date, order)');
  return `${r.summary.current.refundCount} refunds last year`;
});
await check('Webhooks', async () => {
  const signed = await fetch(`${BASE}/shopify/webhooks`, { method: 'POST', body: '{}', headers: { 'x-shopify-topic': 'orders/create', 'x-shopify-shop-domain': shop, 'x-shopify-event-id': 'report', 'x-shopify-hmac-sha256': 'forged' } });
  assert(signed.status === 401, 'forged webhook was not rejected');
  const live = config.appUrl.startsWith('https://') ? 'registered against APP_URL' : 'not registered: APP_URL is not public HTTPS (scheduled incremental sync active)';
  return `signature check enforced; ${live}`;
});
await check('Date Filters', async () => {
  for (const preset of ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month', 'this_year', 'last_year']) await get(`/api/dashboard/sales?preset=${preset}`);
  await get('/api/dashboard/sales?start_date=2025-01-01&end_date=2025-12-31&compare=previous_year');
  const bad = await fetch(`${BASE}/api/dashboard/sales?start_date=2026-09-30&end_date=2026-09-01`, { headers });
  assert(bad.status === 400, 'invalid range accepted');
  return 'all presets, custom and comparison ranges OK';
});
await check('Dashboard API', async () => {
  assert(!overview.error, overview.error);
  for (const name of ['sales', 'orders', 'customers', 'products', 'inventory', 'refunds', 'fulfillment', 'funnel']) await get(`/api/dashboard/${name}?preset=last_30_days`);
  const f = await get('/api/dashboard/funnel?preset=last_30_days');
  if (f.shopifyAnalytics.available) fetched.push('Sessions, add-to-cart, reached-checkout, completed-checkout sessions (ShopifyQL)');
  else needsPermission.push(`ShopifyQL sessions: ${f.shopifyAnalytics.reason}`);
  needsTracking.push('Product views', 'Payment attempts', 'Unique visitors per step (first-party)');
  notExposed.push('Page views per URL, button clicks, scroll depth, mouse movement, session duration');
  return `9 endpoints OK; revenue last 30 days ${overview.sales.current.totalSales} ${overview.currency}`;
});

const pad = Math.max(...results.map(([n]) => n.length));
console.log('\n================ TEST REPORT ================');
for (const [name, result, note] of results) console.log(`${name.padEnd(pad)}: ${result}   ${note || ''}`);
console.log('\n1. Data fetched from Shopify:'); fetched.forEach((x) => console.log(`   - ${x}`));
console.log('2. Requires additional Shopify permissions:'); (needsPermission.length ? needsPermission : ['None — all configured scopes are granted']).forEach((x) => console.log(`   - ${x}`));
console.log('3. Not exposed by the Shopify Admin API:'); notExposed.forEach((x) => console.log(`   - ${x}`));
console.log('4. Requires custom storefront tracking (pixel/web-pixel.js):'); needsTracking.forEach((x) => console.log(`   - ${x}`));
process.exit(results.some(([, r]) => r === 'FAIL') ? 1 : 0);
