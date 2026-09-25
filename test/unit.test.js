// Offline tests: Shopify is replaced by a scripted fetch so security paths (bad HMAC, revoked tokens,
// throttling) can be exercised deterministically. Live verification lives in live-connection.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = 'test-secret';
const SHOP = 'test-shop.myshopify.com';
Object.assign(process.env, {
  NODE_ENV: 'test', LOG_SILENT: '1', SHOPIFY_CLIENT_ID: 'test-client', SHOPIFY_CLIENT_SECRET: SECRET, SHOPIFY_STORE: SHOP,
  SHOPIFY_ADMIN_DOMAIN: '', SHOPIFY_ADMIN_ACCESS_TOKEN: '', TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  APP_URL: 'http://localhost:0', DASHBOARD_API_KEY: ''
});

const { db, localDate } = await import('../src/database/db.js');
const { encrypt, decrypt, verifyQueryHmac, verifyWebhookHmac } = await import('../src/auth/crypto.js');
const tokens = await import('../src/auth/token_service.js');
const { graphql, paginate } = await import('../src/shopify/client.js');
const { saveOrder } = await import('../src/shopify/orders.js');
const { acceptWebhook } = await import('../src/shopify/webhooks.js');
const { resolveRange } = await import('../src/dashboard/dates.js');
const metrics = await import('../src/dashboard/metrics.js');
const { handle } = await import('../src/app.js');

// ---- scripted Shopify ----------------------------------------------------------------------
const realFetch = globalThis.fetch;
let script = [];
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.startsWith('http://127.0.0.1')) return realFetch(url, init);
  calls.push({ url: target, init });
  const next = script.shift();
  if (!next) throw new Error(`Unexpected Shopify call: ${target}`);
  if (next instanceof Error) throw next;
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'content-type': 'application/json', ...(next.headers || {}) } });
};
const reset = () => { script = []; calls.length = 0; };
const signQuery = (params) => {
  const message = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  return { ...params, hmac: createHmac('sha256', SECRET).update(message).digest('hex') };
};

let base;
const server = createServer(handle);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const shopRow = () => db.prepare(`INSERT OR REPLACE INTO shops (shop, name, currency, iana_timezone, updated_at) VALUES (?, 'Test', 'AUD', 'Australia/Melbourne', ?)`).run(SHOP, new Date().toISOString());
const completeSync = () => { for (const r of ['orders', 'customers', 'products', 'variants', 'inventory']) db.prepare(`INSERT OR REPLACE INTO sync_state (shop, resource, complete, last_run_at) VALUES (?, ?, 1, ?)`).run(SHOP, r, new Date().toISOString()); };

// ---- 1-3: authentication -------------------------------------------------------------------
test('1. OAuth start redirects to Shopify with state, scopes and a state cookie', async () => {
  const response = await realFetch(`${base}/shopify/auth?shop=${SHOP}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.host, SHOP);
  assert.equal(location.searchParams.get('client_id'), 'test-client');
  assert.ok(location.searchParams.get('scope').includes('read_orders'));
  assert.match(response.headers.get('set-cookie'), /shopify_oauth_state=[0-9a-f]{48}; Path=\/shopify\/auth; HttpOnly/);
});

test('2. OAuth callback: valid HMAC + state exchanges code and stores the token encrypted', async () => {
  reset();
  const start = await realFetch(`${base}/shopify/auth?shop=${SHOP}`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const params = signQuery({ code: 'auth-code', shop: SHOP, state, timestamp: String(Math.floor(Date.now() / 1000)) });
  script.push({ body: { access_token: 'shpat_live_token_value', scope: 'read_orders,read_products' } });
  // The post-install background syncs (main + separate inventory job) are refused without retries, so they can't leak into later tests.
  script.push({ status: 403 }, { status: 403 });
  const response = await realFetch(`${base}/shopify/auth/callback?${new URLSearchParams(params)}`, { redirect: 'manual', headers: { cookie: `shopify_oauth_state=${state}` } });
  assert.equal(response.status, 302);
  assert.equal(JSON.parse(calls[0].init.body).code, 'auth-code');
  const row = db.prepare('SELECT token_enc, grant_type FROM access_tokens WHERE shop = ?').get(SHOP);
  assert.equal(row.grant_type, 'authorization_code');
  assert.ok(!row.token_enc.includes('shpat_'), 'token must not be stored in plaintext');
  assert.equal(decrypt(row.token_enc), 'shpat_live_token_value');
  await new Promise((r) => setTimeout(r, 50)); reset();
});

test('3. HMAC validation rejects tampered callbacks, bad state and missing cookie', async () => {
  const params = signQuery({ code: 'x', shop: SHOP, state: 'abc', timestamp: String(Math.floor(Date.now() / 1000)) });
  assert.equal(verifyQueryHmac(new URLSearchParams(params)), true);
  assert.equal(verifyQueryHmac(new URLSearchParams({ ...params, code: 'tampered' })), false);
  const bad = await realFetch(`${base}/shopify/auth/callback?${new URLSearchParams({ ...params, shop: SHOP, hmac: 'f'.repeat(64) })}`, { redirect: 'manual' });
  assert.equal(bad.status, 401); assert.equal((await bad.json()).category, 'invalid_hmac');
  const badState = await realFetch(`${base}/shopify/auth/callback?${new URLSearchParams(params)}`, { redirect: 'manual' });
  assert.equal(badState.status, 401); assert.equal((await badState.json()).category, 'invalid_state');
});

// ---- 4, 11, 15, 17, 18: Admin API client -----------------------------------------------------
test('4. Admin API request sends the token header server-side and returns data', async () => {
  reset();
  script.push({ body: { data: { shop: { name: 'Test' } }, extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1999, restoreRate: 100 } } } } });
  const data = await graphql(SHOP, '{ shop { name } }');
  assert.equal(data.shop.name, 'Test');
  assert.equal(calls[0].init.headers['X-Shopify-Access-Token'], 'shpat_live_token_value');
  assert.match(calls[0].url, /\/admin\/api\/2026-07\/graphql\.json$/);
});

test('11. Cursor pagination follows every page', async () => {
  reset();
  const page = (ids, next) => ({ body: { data: { orders: { nodes: ids.map((id) => ({ id })), pageInfo: { hasNextPage: Boolean(next), endCursor: next } } } } });
  script.push(page([1, 2], 'c1'), page([3, 4], 'c2'), page([5], null));
  const seen = [];
  for await (const nodes of paginate(SHOP, 'q', {}, (d) => d.orders)) seen.push(...nodes.map((n) => n.id));
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(JSON.parse(calls[1].init.body).variables.after, 'c1');
  assert.equal(JSON.parse(calls[2].init.body).variables.after, 'c2');
});

test('15. Rate limits: HTTP 429 and GraphQL THROTTLED are retried', async () => {
  reset();
  script.push({ status: 429, headers: { 'retry-after': '0' } });
  script.push({ body: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 9, restoreRate: 100 } } } } });
  script.push({ body: { data: { ok: true } } });
  assert.deepEqual(await graphql(SHOP, '{ ok }'), { ok: true });
  assert.equal(calls.length, 3);
});

test('Missing scopes and 403 are reported as permission errors', async () => {
  reset();
  script.push({ body: { errors: [{ message: 'Access denied for orders field.', extensions: { code: 'ACCESS_DENIED' } }] } });
  await assert.rejects(graphql(SHOP, '{ orders }'), (e) => e.category === 'missing_scope');
  script.push({ status: 403 });
  await assert.rejects(graphql(SHOP, '{ x }'), (e) => e.category === 'permission_denied');
});

test('17. Revoked authorization: a 401 revokes the OAuth token and requires reconnect', async () => {
  reset();
  script.push({ status: 401 });
  await assert.rejects(graphql(SHOP, '{ shop { name } }'), (e) => e.category === 'revoked');
  assert.equal(tokens.tokenStatus(SHOP).revoked, true);
});

test('18. Invalid credentials: failed client-credentials grant surfaces not_connected', async () => {
  reset();
  const other = 'other-shop.myshopify.com';
  script.push({ status: 401, body: { error: 'invalid_client' } });
  await assert.rejects(tokens.getAccessToken(other), (e) => e.category === 'not_connected');
});

// ---- 7-10, 12: data + metrics ----------------------------------------------------------------
const money = (amount) => ({ shopMoney: { amount: String(amount) } });
function order(id, processedAt, { total = 110, gross = 100, discount = 0, refunds = [], cancelledAt = null, customer = 'gid://shopify/Customer/1', test: isTest = false } = {}) {
  return {
    id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: processedAt, processedAt, updatedAt: processedAt, cancelledAt, cancelReason: cancelledAt ? 'CUSTOMER' : null,
    test: isTest, sourceName: 'web', app: { name: 'Online Store' }, displayFinancialStatus: refunds.length ? 'PARTIALLY_REFUNDED' : 'PAID', displayFulfillmentStatus: 'FULFILLED',
    customer: customer && { id: customer, displayName: 'Jane D' }, totalDiscountsSet: money(discount), totalTaxSet: money(10), totalShippingPriceSet: money(0),
    totalPriceSet: money(total), currentTotalPriceSet: money(total), totalRefundedSet: money(refunds.reduce((s, r) => s + r.amount, 0)),
    shippingAddress: { provinceCode: 'VIC', countryCode: 'AU' }, retailLocation: null,
    refunds: refunds.map((r, i) => ({ id: `gid://shopify/Refund/${id}${i}`, createdAt: r.at, totalRefundedSet: money(r.amount) }))
  };
}
const items = (id, gross, qty = 2) => [{ id: `gid://shopify/LineItem/${id}`, title: 'Print A4', variantTitle: 'Gloss', sku: 'A4', quantity: qty, currentQuantity: qty, product: { id: 'gid://shopify/Product/9' }, variant: { id: 'gid://shopify/ProductVariant/9' }, originalTotalSet: money(gross), totalDiscountSet: money(0) }];

test('7/10/12. Orders, refunds and date filtering compute real totals in shop timezone', () => {
  shopRow(); completeSync();
  const tz = 'Australia/Melbourne';
  // 2026-09-10T15:30Z is 11 Sep 01:30 in Melbourne: must land on the 11th.
  saveOrder(SHOP, order(1, '2026-09-10T15:30:00Z', { gross: 100, total: 110 }), items(1, 100), tz);
  saveOrder(SHOP, order(2, '2026-09-12T02:00:00Z', { gross: 200, total: 190, discount: 20, refunds: [{ at: '2026-09-13T01:00:00Z', amount: 50 }] }), items(2, 200, 4), tz);
  saveOrder(SHOP, order(3, '2026-09-12T03:00:00Z', { cancelledAt: '2026-09-12T04:00:00Z' }), items(3, 100), tz);
  saveOrder(SHOP, order(4, '2026-09-12T03:00:00Z', { test: true }), items(4, 999), tz);
  assert.equal(localDate('2026-09-10T15:30:00Z', tz), '2026-09-11');

  const s = metrics.salesSummary(SHOP, '2026-09-11', '2026-09-13');
  assert.equal(s.orders, 2); assert.equal(s.grossSales, 300); assert.equal(s.discounts, 20); assert.equal(s.refunds, 50);
  assert.equal(s.netSales, 230); assert.equal(s.totalSales, 300); assert.equal(s.averageOrderValue, 150); assert.equal(s.units, 6); assert.equal(s.cancelledOrders, 1);
  assert.equal(metrics.salesSummary(SHOP, '2026-09-10', '2026-09-10').orders, 0, 'order must not leak into UTC date');
  assert.equal(metrics.salesSummary(SHOP, '2026-09-01', '2026-09-05').averageOrderValue, null, 'no orders => no AOV, not zero');

  // Re-saving the same order (duplicate sync) must not duplicate line items/refunds.
  saveOrder(SHOP, order(2, '2026-09-12T02:00:00Z', { gross: 200, total: 190, discount: 20, refunds: [{ at: '2026-09-13T01:00:00Z', amount: 50 }] }), items(2, 200, 4), tz);
  assert.equal(metrics.salesSummary(SHOP, '2026-09-11', '2026-09-13').refunds, 50);

  const t = metrics.trend(SHOP, { startDate: '2026-09-10', endDate: '2026-09-13', granularity: 'day' });
  assert.deepEqual(t.map((p) => p.orders), [0, 1, 1, 0]);
  assert.equal(t[3].refunds, 50);
});

test('12. Date presets and custom ranges resolve correctly', () => {
  const p = (q) => resolveRange(new URLSearchParams(q), 'Australia/Melbourne');
  const today = p('preset=today');
  assert.equal(today.startDate, today.endDate);
  assert.equal(p('preset=last_7_days').days, 7);
  const custom = p('start_date=2026-09-01&end_date=2026-09-25');
  assert.equal(custom.preset, 'custom'); assert.equal(custom.days, 25);
  const yoy = p('preset=custom&start_date=2026-01-01&end_date=2026-12-31&compare=previous_year');
  assert.deepEqual([yoy.comparison.startDate, yoy.comparison.endDate], ['2025-01-01', '2025-12-31']);
  assert.equal(p('start_date=2025-01-01&end_date=2026-12-31').granularity, 'quarter');
  assert.throws(() => p('start_date=2026-09-30&end_date=2026-09-01'));
  assert.throws(() => p('start_date=2026-02-30&end_date=2026-03-01'));
});

// ---- 13-14: webhooks -----------------------------------------------------------------------
const webhook = (body, { topic = 'inventory_levels/update', id = randomBytes(8).toString('hex'), secret = SECRET } = {}) => {
  const raw = JSON.stringify(body);
  return realFetch(`${base}/shopify/webhooks`, { method: 'POST', body: raw, headers: {
    'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': SHOP, 'x-shopify-event-id': id,
    'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64') } });
};

test('13. Webhook signatures are verified before processing', async () => {
  assert.equal(verifyWebhookHmac(Buffer.from('{}'), createHmac('sha256', SECRET).update('{}').digest('base64')), true);
  const forged = await webhook({ inventory_item_id: 1, location_id: 1, available: 3 }, { secret: 'wrong' });
  assert.equal(forged.status, 401);
  const ok = await webhook({ inventory_item_id: 77, location_id: 5, available: 3, updated_at: '2026-09-25T00:00:00Z' });
  assert.equal(ok.status, 200);
  const row = db.prepare('SELECT available FROM inventory_levels WHERE inventory_item_id = ?').get('gid://shopify/InventoryItem/77');
  assert.equal(row.available, 3);
});

test('14. Duplicate webhook deliveries are processed once', async () => {
  const first = await webhook({ inventory_item_id: 88, location_id: 5, available: 4 }, { id: 'evt-dup' });
  assert.equal((await first.json()).duplicate, false);
  db.prepare('UPDATE inventory_levels SET available = 999 WHERE inventory_item_id = ?').run('gid://shopify/InventoryItem/88');
  const second = await webhook({ inventory_item_id: 88, location_id: 5, available: 4 }, { id: 'evt-dup' });
  assert.equal((await second.json()).duplicate, true);
  assert.equal(db.prepare('SELECT available FROM inventory_levels WHERE inventory_item_id = ?').get('gid://shopify/InventoryItem/88').available, 999);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = 'evt-dup'").get().n, 1);
});

// ---- 16: dashboard API ---------------------------------------------------------------------
test('16. Dashboard endpoints return live-shaped data, never secrets', async () => {
  const endpoints = ['overview', 'sales', 'orders', 'customers', 'products', 'inventory', 'refunds', 'fulfillment'];
  for (const name of endpoints) {
    const response = await realFetch(`${base}/api/dashboard/${name}?start_date=2026-09-11&end_date=2026-09-13`);
    const text = await response.text();
    assert.equal(response.status, 200, `${name}: ${text}`);
    assert.ok(!/shpat_|test-secret|token_enc/.test(text), `${name} leaked a credential`);
  }
  const sales = await (await realFetch(`${base}/api/dashboard/sales?start_date=2026-09-11&end_date=2026-09-13`)).json();
  assert.equal(sales.summary.current.netSales, 230);
  const bad = await realFetch(`${base}/api/dashboard/sales?preset=nope`);
  assert.equal(bad.status, 400);
  const status = await (await realFetch(`${base}/api/status`)).text();
  assert.ok(!/shpat_|token_enc/.test(status));
});

test('Profit: product costs, spread fixed costs, manual ad spend; missing inputs are named, not estimated', async () => {
  const profit = await import('../src/dashboard/profit.js');
  const range = { startDate: '2026-09-11', endDate: '2026-09-13', granularity: 'day' };
  // Nothing set up: profit = net sales, and every missing input is listed.
  let r = profit.profitReport(SHOP, range, { netSales: 500, shopCurrency: 'AUD' });
  assert.equal(r.operatingProfit, 500);
  assert.deepEqual(r.missing, ['product costs', 'ad spend', 'fixed costs', 'labour']);

  // Variant 9 costs $10; orders 1 (2 units) + 2 (4 units) are in range => $60 product costs.
  db.prepare("INSERT OR REPLACE INTO variants (id, shop, product_id, title, unit_cost, updated_at) VALUES ('gid://shopify/ProductVariant/9', ?, 'gid://shopify/Product/9', 'Gloss', 10, '')").run(SHOP);
  profit.addCost(SHOP, { name: 'Rent', category: 'fixed', amount: 3000, frequency: 'monthly', startDate: '2026-09-01' }); // Sept has 30 days => $100/day
  profit.addCost(SHOP, { name: 'Wages', category: 'labour', amount: 70, frequency: 'weekly', startDate: '2026-09-12', endDate: '2026-09-12' }); // one day of $10
  profit.addManualAdSpend(SHOP, { platform: 'meta', amount: 90, startDate: '2026-09-11', endDate: '2026-09-13' }, 'AUD'); // $30/day spread
  profit.addManualAdSpend(SHOP, { platform: 'google', amount: 25, startDate: '2026-09-12' }, 'USD'); // other currency: excluded
  r = profit.profitReport(SHOP, range, { netSales: 500, shopCurrency: 'AUD' });
  assert.equal(r.productCosts, 60); assert.equal(r.fixedCosts, 300); assert.equal(r.labour, 10); assert.equal(r.adSpend, 90);
  assert.equal(r.operatingProfit, 500 - 460); assert.equal(r.profitMargin, 0.08);
  assert.deepEqual(r.missing, []);
  assert.ok(r.warnings.some((w) => w.includes('USD')));
  assert.equal(r.trend.length, 3);
  assert.throws(() => profit.addCost(SHOP, { name: 'x', category: 'fixed', amount: -1, frequency: 'monthly', startDate: '2026-09-01' }));
  // Net sales unavailable => no profit invented.
  assert.equal(profit.profitReport(SHOP, range, { netSales: null, shopCurrency: 'AUD' }).operatingProfit, null);
});

test('Staff: shift costs replace entered labour only in timesheet mode (no double counting)', async () => {
  const profit = await import('../src/dashboard/profit.js');
  const staff = await import('../src/dashboard/staff.js');
  const range = { startDate: '2026-09-11', endDate: '2026-09-13', granularity: 'day' };
  const { id } = staff.addStaff(SHOP, { name: 'Alex', hourlyRate: 30, onCostPct: 10 });
  staff.addShift(SHOP, { staffId: id, date: '2026-09-12', hours: 8, extraCosts: 5 }); // 8 × 30 × 1.1 + 5 = 269
  // Fixed payroll mode (default): labour = the $10 entered in the previous test; the shift is review-only.
  assert.equal(profit.profitReport(SHOP, range, { netSales: 500, shopCurrency: 'AUD' }).labour, 10);
  staff.setLabourMethod(SHOP, 'timesheets');
  const r = profit.profitReport(SHOP, range, { netSales: 500, shopCurrency: 'AUD' });
  assert.equal(r.labour, 269);
  assert.equal(staff.staffOverview(SHOP, range).cards.labourExpense, 269);
  assert.throws(() => staff.setLabourMethod(SHOP, 'both'));
  assert.throws(() => staff.addShift(SHOP, { staffId: id, date: '2026-09-12', hours: 30 }));
  // Staff with shifts are deactivated, not deleted, so history stays.
  assert.deepEqual(staff.removeStaff(SHOP, id), { removed: true, deactivated: true });
  staff.setLabourMethod(SHOP, 'fixed_payroll');
});

test('Tokens round-trip through AES-GCM and tampering is detected', () => {
  const sealed = encrypt('shpat_abc');
  assert.equal(decrypt(sealed), 'shpat_abc');
  const [iv, tag, body] = sealed.split('.');
  assert.throws(() => decrypt([iv, tag, body.slice(0, -2) + (body.endsWith('A') ? 'BB' : 'AA')].join('.')));
});
