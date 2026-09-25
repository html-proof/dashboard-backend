import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { log } from './logger.js';
import { safeEqual } from './auth/crypto.js';
import { beginAuth, completeAuth, OAuthError } from './auth/shopify_oauth.js';
import { tokenStatus } from './auth/token_service.js';
import { clearSessionCookie, sessionCookie, sessionShop } from './auth/session.js';
import { PROVIDERS, listIntegrations, removeIntegration, saveIntegration } from './integrations/index.js';
import { syncMetaSpend } from './ads/meta.js';
import { localDate } from './database/db.js';
import { acceptWebhook, registerWebhooks, WebhookError } from './shopify/webhooks.js';
import { markChanged, syncShop, syncStatus } from './shopify/sync.js'; // syncStatus includes dataVersion
import { AD_PLATFORMS, COST_CATEGORIES, FREQUENCIES, ValidationError, addCost, addManualAdSpend, deleteAdSpendEntry, deleteCost, listAdSpend, listCosts, missingCostProducts, profitReport } from './dashboard/profit.js';
import { metaStatus } from './ads/meta.js';
import { buildProfitReport } from './dashboard/profit_report.js';
import { salesSources } from './dashboard/sales_sources.js';
import { costsOverview } from './dashboard/costs_page.js';
import { getPlan, savePlan } from './dashboard/annual_plan.js';
import { LABOUR_METHODS, addShift, addStaff, deleteShift, listStaff, removeStaff, setLabourMethod, staffOverview } from './dashboard/staff.js';
import { FIXED_SUBCATEGORIES } from './dashboard/profit.js';
import { getStore } from './shopify/store.js';
import { salesReport, salesReportSeries, sessionFunnel } from './shopify/analytics.js';
import { cache } from './cache.js';
import { addDays, bucketKey, resolveRange, RangeError400 } from './dashboard/dates.js';
import { buildInsights } from './dashboard/insights.js';
import * as m from './dashboard/metrics.js';
import { recordEvent, trackingFunnel } from './dashboard/tracking.js';

const publicDir = join(process.cwd(), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  ...(config.appUrl.startsWith('https://') ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {})
};

// ---- helpers -------------------------------------------------------------------------------
function send(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  response.end(JSON.stringify(payload));
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => { size += chunk.length; if (size > limit) { reject(new WebhookError('Body too large', 413)); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

// Fixed-window rate limiter per client IP and bucket.
const windows = new Map();
function rateLimited(request, bucket, perMinute) {
  const ip = request.socket.remoteAddress || 'unknown';
  const key = `${bucket}:${ip}`; const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.reset < now) { windows.set(key, { count: 1, reset: now + 60_000 }); return false; }
  entry.count += 1;
  return entry.count > perMinute;
}
setInterval(() => { const now = Date.now(); for (const [key, entry] of windows) if (entry.reset < now) windows.delete(key); }, 60_000).unref();

function authorised(request) {
  if (!config.dashboardApiKey) return true;
  const header = request.headers.authorization || '';
  return safeEqual(header.replace(/^Bearer\s+/i, ''), config.dashboardApiKey);
}

const ERROR_STATUS = { invalid_store: 400, not_configured: 500, not_connected: 401, revoked: 401, unauthorized: 401, permission_denied: 403, missing_scope: 403, rate_limited: 429, network: 502, upstream: 502, graphql_error: 502, shopifyql_error: 502, user_errors: 502 };

function fail(response, error, requestId) {
  if (error instanceof ValidationError) return send(response, 400, { error: error.message, category: 'invalid_input', requestId });
  if (error instanceof RangeError400) return send(response, 400, { error: error.message, category: 'invalid_date_range', requestId });
  const category = error.category || (/sqlite|database/i.test(error.message) ? 'database' : 'internal');
  const status = ERROR_STATUS[category] || 500;
  log.error('request.failed', { requestId, category, status, error: error.message });
  // Only curated messages are exposed; they never contain credentials.
  send(response, status, { error: status === 500 ? 'Internal error' : error.message, category, requestId });
}

// The signed-in store (session cookie from Shopify OAuth) wins; the server's own SHOPIFY_STORE is the
// fallback for single-store installs, still guarded by DASHBOARD_API_KEY.
function currentShop(request) {
  const shop = sessionShop(request) || config.shopify.store;
  if (!shop) throw Object.assign(new Error('Connect your Shopify store to continue.'), { category: 'not_connected' });
  return shop;
}

function rangeFor(shop, url) {
  const tz = getStore(shop)?.iana_timezone;
  if (!tz) throw Object.assign(new Error('Store details have not been synced yet. Connect the store or wait for the first sync.'), { category: 'not_connected' });
  return resolveRange(url.searchParams, tz);
}

const intParam = (url, name, fallback, max) => Math.min(max, Math.max(0, Number.parseInt(url.searchParams.get(name) ?? fallback, 10) || fallback));

function meta(shop, range, resources) {
  const store = getStore(shop);
  return {
    source: 'Shopify Admin API (synced to local database)', shop, currency: store?.currency || null, timezone: range?.timeZone || null,
    range: range && { preset: range.preset, startDate: range.startDate, endDate: range.endDate, granularity: range.granularity, comparison: range.comparison },
    dataQuality: m.dataQuality(shop, resources), generatedAt: new Date().toISOString()
  };
}

function withComparison(shop, range, compute) {
  const current = compute(range.startDate, range.endDate);
  if (!range.comparison) return { current, comparison: null };
  return { current, comparison: { ...range.comparison, values: compute(range.comparison.startDate, range.comparison.endDate) } };
}

// Shopify's sales report (ShopifyQL). Kept apart from the order-based figures because the definitions differ.
async function shopifyReport(shop, range, { series = false } = {}) {
  try {
    const current = await salesReport(shop, range.startDate, range.endDate);
    const comparison = range.comparison ? { ...range.comparison, values: await salesReport(shop, range.comparison.startDate, range.comparison.endDate) } : null;
    return {
      available: true, source: 'Shopify Analytics sales report (ShopifyQL, read_reports). Matches Shopify admin reports.',
      definitions: 'Gross/net sales exclude tax; returns exclude refunded shipping/tax; total sales = net sales + taxes + shipping (after returns).',
      current, comparison, ...(series ? { trend: await salesReportSeries(shop, range) } : {})
    };
  } catch (error) {
    return { available: false, reason: `${error.category || 'error'}: ${error.message}` };
  }
}

// Profit combines Shopify's net sales (report) with product costs, ad spend and entered costs.
function profitFor(shop, range, report) {
  const netSalesByPeriod = new Map((report.trend || []).map((p) => [/^\d{4}-\d{2}-\d{2}$/.test(p.period) ? bucketKey(p.period, range.granularity) : p.period, p.netSales]));
  return {
    ...profitReport(shop, range, { netSales: report.available ? report.current?.netSales ?? null : null, netSalesByPeriod, shopCurrency: getStore(shop)?.currency }),
    missingCostProducts: missingCostProducts(shop, range, 10),
    meta: metaStatus(shop)
  };
}

async function readJson(request) {
  if (!/application\/json/.test(request.headers['content-type'] || '')) throw new ValidationError('Send JSON (content-type: application/json).');
  return JSON.parse((await readBody(request, 32_000)).toString('utf8') || '{}');
}

// ---- dashboard endpoints -------------------------------------------------------------------
function legacyOverview(shop, range, report) {
  return {
    shopifyReport: report,
    ...meta(shop, range, ['orders', 'customers', 'products']),
    inventoryQuality: m.dataQuality(shop, ['inventory']),
    store: getStore(shop),
    periods: m.fixedPeriods(shop),
    sales: withComparison(shop, range, (s, e) => m.salesSummary(shop, s, e)),
    customers: withComparison(shop, range, (s, e) => m.customerSummary(shop, s, e)),
    trend: m.trend(shop, range),
    ...m.breakdowns(shop, range, 8),
    topCustomers: m.topCustomers(shop, range, 5),
    latestOrders: m.listOrders(shop, range, { limit: 10 }).orders,
    refundedOrders: m.listOrders(shop, range, { filter: 'refunded', limit: 10 }).orders,
    cancelledOrders: m.listOrders(shop, range, { filter: 'cancelled', limit: 10 }).orders,
    lowInventory: m.inventoryTable(shop, { limit: 10 }).lowStock
  };
}

const dashboard = {
  overview: async (shop, range) => {
    const report = await shopifyReport(shop, range, { series: true });
    const previous = { startDate: addDays(range.startDate, -range.days), endDate: addDays(range.startDate, -1) };
    const previousReport = report.available ? await salesReport(shop, previous.startDate, previous.endDate).catch(() => null) : null;
    const funnel = await cache.wrap(shop, `funnel:${range.startDate}:${range.endDate}`, () => sessionFunnel(shop, range)).catch(() => null);
    const sales = m.salesSummary(shop, range.startDate, range.endDate);
    const currency = getStore(shop)?.currency || 'AUD';
    const money = (v) => new Intl.NumberFormat('en-AU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
    const profitability = profitFor(shop, range, report);
    return {
      ...legacyOverview(shop, range, report),
      funnel: funnel && { steps: funnel.steps, source: 'Shopify Analytics sessions (ShopifyQL)' },
      previousPeriod: { ...previous, report: previousReport },
      insights: buildInsights(shop, range, { report: report.current, previousReport, sales, funnel, money, profitability }),
      profitability
    };
  },
  sales: async (shop, range) => ({ ...meta(shop, range, ['orders']), shopifyReport: await shopifyReport(shop, range, { series: true }), summary: withComparison(shop, range, (s, e) => m.salesSummary(shop, s, e)), trend: m.trend(shop, range), ...m.breakdowns(shop, range, 20), definitions: m.DEFINITIONS }),
  orders: (shop, range, url) => ({ ...meta(shop, range, ['orders']), ...m.listOrders(shop, range, { filter: url.searchParams.get('status') || 'all', limit: intParam(url, 'limit', 25, 250), offset: intParam(url, 'offset', 0, 1e9) }) }),
  customers: (shop, range) => ({ ...meta(shop, range, ['customers', 'orders']), summary: withComparison(shop, range, (s, e) => m.customerSummary(shop, s, e)), trend: m.trend(shop, range).map(({ period, customers }) => ({ period, customers })), topCustomers: m.topCustomers(shop, range, 25), definitions: m.DEFINITIONS }),
  products: (shop, range, url) => ({ ...meta(shop, range, ['products', 'variants', 'orders']), ...m.productTable(shop, range, { limit: intParam(url, 'limit', 50, 250), offset: intParam(url, 'offset', 0, 1e9), q: url.searchParams.get('q') || '' }) }),
  inventory: (shop, range, url) => ({ ...meta(shop, range, ['inventory', 'variants']), ...m.inventoryTable(shop, { threshold: intParam(url, 'threshold', 5, 10_000), limit: intParam(url, 'limit', 100, 500), q: url.searchParams.get('q') || '' }) }),
  refunds: (shop, range) => ({ ...meta(shop, range, ['orders']), summary: withComparison(shop, range, (s, e) => { const x = m.salesSummary(shop, s, e); return { refunds: x.refunds, refundCount: x.refundCount }; }), trend: m.trend(shop, range).map(({ period, refunds }) => ({ period, refunds })), refunds: m.refundList(shop, range, 100) }),
  fulfillment: (shop, range) => ({ ...meta(shop, range, ['orders']), ...m.statusBreakdown(shop, range), unfulfilled: m.listOrders(shop, range, { filter: 'unfulfilled', limit: 50 }) }),
  staff: (shop, range) => ({ ...meta(shop, range, []), ...staffOverview(shop, range), methods: LABOUR_METHODS, days: range.days }),
  costs: (shop, range) => ({ ...meta(shop, range, ['orders', 'variants']), ...costsOverview(shop, range), subcategories: FIXED_SUBCATEGORIES, frequencies: FREQUENCIES }),
  salessources: async (shop, range) => ({ ...meta(shop, range, ['orders', 'variants']), ...(await salesSources(shop, range)) }),
  profitreport: async (shop, range) => ({ ...meta(shop, range, ['orders', 'variants']), ...(await buildProfitReport(shop, range, { currency: getStore(shop)?.currency })) }),
  profit: async (shop, range) => ({ ...meta(shop, range, ['orders', 'variants']), ...profitFor(shop, range, await shopifyReport(shop, range, { series: true })) }),
  funnel: async (shop, range) => {
    let shopify;
    try { shopify = { available: true, ...(await cache.wrap(shop, `funnel:${range.startDate}:${range.endDate}`, () => sessionFunnel(shop, range))) }; }
    catch (error) { shopify = { available: false, reason: `${error.category || 'error'}: ${error.message}` }; }
    const orders = m.salesSummary(shop, range.startDate, range.endDate).orders;
    return {
      ...meta(shop, range, ['orders']),
      shopifyAnalytics: { source: 'Shopify Analytics sessions via ShopifyQL (read_reports). Measured by Shopify, not derived from orders.', ...shopify },
      shopifyOrders: { source: 'Shopify Admin API orders (confirmed purchases).', purchases: orders },
      customTracking: { source: 'First-party web pixel events (self-reported by browsers; unverified). Not mixed with Shopify data.', ...trackingFunnel(shop, range) },
      notAvailableFromShopify: ['Product views (not in Admin API or ShopifyQL sessions) → custom tracking', 'Payment attempts → custom tracking (payment_info_submitted)', 'Button clicks, scroll depth, mouse movement, session duration → not collected']
    };
  }
};

// ---- router --------------------------------------------------------------------------------
export async function handle(request, response) {
  const requestId = randomUUID();
  const url = new URL(request.url, 'http://internal');
  const path = url.pathname;
  const started = Date.now();
  response.on('finish', () => { if (path.startsWith('/api') || path.startsWith('/shopify')) log.info('http', { requestId, method: request.method, path, status: response.statusCode, ms: Date.now() - started }); });

  try {
    if (path === '/api/health') return send(response, 200, { ok: true });

    if (path === '/shopify/auth' && request.method === 'GET') {
      if (rateLimited(request, 'auth', 20)) return send(response, 429, { error: 'Too many requests' });
      const { location, setCookie } = beginAuth(url);
      response.writeHead(302, { location, 'set-cookie': setCookie, ...SECURITY_HEADERS }); return response.end();
    }
    if (path === '/shopify/auth/callback' && request.method === 'GET') {
      if (rateLimited(request, 'auth', 20)) return send(response, 429, { error: 'Too many requests' });
      const { shop, clearCookie, missingScopes } = await completeAuth(url, request);
      registerWebhooks(shop).catch((error) => log.error('webhooks.register_failed', { shop, error: error.message }));
      syncShop(shop, { full: true });
      response.writeHead(302, { location: `/?connected=1${missingScopes.length ? `&missing_scopes=${encodeURIComponent(missingScopes.join(','))}` : ''}`, 'set-cookie': [clearCookie, sessionCookie(shop)], ...SECURITY_HEADERS });
      return response.end();
    }
    if (path === '/shopify/webhooks' && request.method === 'POST') {
      const raw = await readBody(request);
      const result = acceptWebhook(raw, request.headers);
      send(response, 200, { ok: true, duplicate: result.duplicate });
      await result.process();
      return;
    }
    if (path === '/api/track') {
      const origin = request.headers.origin || '';
      const cors = { 'access-control-allow-origin': origin || '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', vary: 'origin' };
      if (request.method === 'OPTIONS') { response.writeHead(204, cors); return response.end(); }
      if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' });
      if (rateLimited(request, 'track', 600)) return send(response, 429, { error: 'Too many requests' }, cors);
      const body = JSON.parse((await readBody(request, 64_000)).toString('utf8') || '{}');
      return send(response, 202, { accepted: recordEvent(currentShop(request), body) }, cors);
    }

    if (path.startsWith('/api/')) {
      if (rateLimited(request, 'api', 240)) return send(response, 429, { error: 'Too many requests', category: 'rate_limited' });
      if (path === '/api/logout' && request.method === 'POST') return send(response, 200, { ok: true }, { 'set-cookie': clearSessionCookie() });
      const signedIn = sessionShop(request);
      if (!signedIn && !config.shopify.store) return send(response, 401, { error: 'Connect your Shopify store to continue.', category: 'not_signed_in' });
      if (!signedIn && !authorised(request)) return send(response, 401, { error: 'Dashboard API key required', category: 'dashboard_auth' });
      const shop = signedIn || currentShop(request);

      if (path === '/api/me') return send(response, 200, { shop, store: getStore(shop), signedIn: Boolean(signedIn), token: tokenStatus(shop) });

      // Integrations: each store manages its own platform connections.
      if (path === '/api/integrations' && request.method === 'GET') {
        const store = getStore(shop); const token = tokenStatus(shop);
        return send(response, 200, { shopify: { shop, name: store?.name || null, domain: store?.primary_domain || shop, connected: token.stored ? !token.revoked : Boolean(store), grantType: token.grantType || null, sync: syncStatus(shop) }, integrations: listIntegrations(shop) });
      }
      const integrationMatch = path.match(/^\/api\/integrations\/([a-z_]+)(\/sync)?$/);
      if (integrationMatch && PROVIDERS[integrationMatch[1]]) {
        const provider = integrationMatch[1];
        if (integrationMatch[2] && request.method === 'POST') {
          if (provider !== 'meta') return send(response, 400, { error: `${PROVIDERS[provider].name} imports are not available yet.`, category: 'invalid_input' });
          const rows = await syncMetaSpend(shop, { today: localDate(new Date().toISOString(), getStore(shop)?.iana_timezone || 'UTC') });
          if (rows != null) markChanged(shop);
          return send(response, 200, listIntegrations(shop).find((i) => i.id === provider));
        }
        if (request.method === 'PUT') { const saved = saveIntegration(shop, provider, await readJson(request)); markChanged(shop); return send(response, 200, saved); }
        if (request.method === 'DELETE') { const ok = removeIntegration(shop, provider); if (ok) markChanged(shop); return send(response, ok ? 200 : 404, { deleted: ok }); }
      }

      // Cheap poll target: the dashboard reloads only when this number changes.
      if (path === '/api/version') {
        const s = syncStatus(shop);
        return send(response, 200, { version: s.dataVersion, syncing: s.inProgress.map((p) => p.resource), lastRunAt: s.resources.map((r) => r.last_run_at).sort().pop() || null });
      }
      if (path === '/api/status') {
        const store = getStore(shop);
        return send(response, 200, { shop, connected: Boolean(store), store, token: tokenStatus(shop), sync: syncStatus(shop), webhooksEndpoint: `${config.appUrl}/shopify/webhooks` });
      }
      // Costs & ad spend (business-entered inputs for profit).
      if (path === '/api/costs' && request.method === 'GET') return send(response, 200, { costs: listCosts(shop), categories: COST_CATEGORIES, frequencies: FREQUENCIES });
      if (path === '/api/costs' && request.method === 'POST') { const created = addCost(shop, await readJson(request)); markChanged(shop); return send(response, 201, created); }
      const costMatch = path.match(/^\/api\/costs\/(\d+)$/);
      if (costMatch && request.method === 'DELETE') { const ok = deleteCost(shop, Number(costMatch[1])); if (ok) markChanged(shop); return send(response, ok ? 200 : 404, { deleted: ok }); }
      if (path === '/api/ad-spend' && request.method === 'GET') {
        const range = rangeFor(shop, url);
        return send(response, 200, { entries: listAdSpend(shop, range), platforms: AD_PLATFORMS, meta: metaStatus(shop) });
      }
      if (path === '/api/ad-spend' && request.method === 'POST') { const created = addManualAdSpend(shop, await readJson(request), getStore(shop)?.currency); markChanged(shop); return send(response, 201, created); }
      const adMatch = path.match(/^\/api\/ad-spend\/([A-Za-z0-9-]+)$/);
      if (adMatch && request.method === 'DELETE') { const ok = deleteAdSpendEntry(shop, adMatch[1]); if (ok) markChanged(shop); return send(response, ok ? 200 : 404, { deleted: ok }); }

      // Staff, shifts and labour costing method.
      if (path === '/api/staff' && request.method === 'GET') return send(response, 200, { staff: listStaff(shop) });
      if (path === '/api/staff' && request.method === 'POST') { const r = addStaff(shop, await readJson(request)); markChanged(shop); return send(response, 201, r); }
      const staffMatch = path.match(/^\/api\/staff\/(\d+)$/);
      if (staffMatch && request.method === 'DELETE') { const r = removeStaff(shop, Number(staffMatch[1])); markChanged(shop); return send(response, r.removed ? 200 : 404, r); }
      if (path === '/api/shifts' && request.method === 'POST') { const r = addShift(shop, await readJson(request)); markChanged(shop); return send(response, 201, r); }
      const shiftMatch = path.match(/^\/api\/shifts\/(\d+)$/);
      if (shiftMatch && request.method === 'DELETE') { const r = deleteShift(shop, Number(shiftMatch[1])); markChanged(shop); return send(response, r.removed ? 200 : 404, r); }
      if (path === '/api/settings/labour-method' && request.method === 'PUT') { const r = setLabourMethod(shop, (await readJson(request)).method); markChanged(shop); return send(response, 200, r); }

      // Annual plan.
      if (path === '/api/plan' && request.method === 'GET') {
        const year = Number(url.searchParams.get('year')) || Number(new Date().getFullYear());
        return send(response, 200, await getPlan(shop, year));
      }
      if (path === '/api/plan' && request.method === 'PUT') { const r = savePlan(shop, await readJson(request)); return send(response, 200, r); }

      if (path === '/api/sync' && request.method === 'POST') {
        syncShop(shop, { full: url.searchParams.get('full') === '1' });
        return send(response, 202, { started: true, sync: syncStatus(shop) });
      }
      const match = path.match(/^\/api\/dashboard\/([a-z]+)$/);
      if (match && dashboard[match[1]] && request.method === 'GET') {
        const range = rangeFor(shop, url);
        const key = `${match[1]}:${url.searchParams.toString()}`;
        const payload = await cache.wrap(shop, key, () => dashboard[match[1]](shop, range, url));
        return send(response, 200, payload);
      }
      return send(response, 404, { error: 'Not found' });
    }

    // Static dashboard files.
    // Signed-out visitors connect their own store first (unless the server is a single-store install).
    if ((path === '/' || path.endsWith('.html')) && path !== '/connect.html' && !sessionShop(request) && !config.shopify.store) {
      response.writeHead(302, { location: '/connect.html', ...SECURITY_HEADERS }); return response.end();
    }
    const file = normalize(join(publicDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(publicDir + sep)) return send(response, 403, { error: 'Forbidden' });
    try {
      const content = await readFile(file);
      response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
      return response.end(content);
    } catch { return send(response, 404, { error: 'Not found' }); }
  } catch (error) {
    if (error instanceof OAuthError) { log.warn('oauth.rejected', { requestId, category: error.category }); return send(response, error.category === 'not_configured' ? 500 : 401, { error: error.message, category: error.category, requestId }); }
    if (error instanceof WebhookError) { log.warn('webhook.rejected', { requestId, status: error.status, error: error.message }); return send(response, error.status, { error: error.message }); }
    if (error instanceof SyntaxError) return send(response, 400, { error: 'Invalid JSON' });
    if (response.headersSent) { log.error('request.failed_after_response', { requestId, error: error.message }); return; }
    return fail(response, error, requestId);
  }
}
