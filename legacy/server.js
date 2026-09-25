import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

try {
  const env = await readFile(join(process.cwd(), '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* .env is optional */ }

const port = Number(process.env.PORT || 3000);
const storefrontDomain = process.env.SHOPIFY_STOREFRONT_DOMAIN || 'www.pixmagic.com.au';
const publicDir = join(process.cwd(), 'public');
const cache = { value: null, expiresAt: 0 };
const siteCache = { value: null, expiresAt: 0 };
const adminTokenCache = { value: null, expiresAt: 0 };
const cacheTtlMs = 15_000;
const oauthStates = new Set();
let authorizedAdmin = null;
const mime = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function toProduct(product) {
  const available = product.variants.filter((variant) => variant.available);
  const prices = product.variants.map((variant) => Number(variant.price)).filter(Number.isFinite);
  return {
    id: product.id,
    title: product.title,
    description: String(product.body_html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    handle: product.handle,
    type: product.product_type || 'Uncategorised',
    vendor: product.vendor || '',
    tags: product.tags || [],
    available: available.length > 0,
    variantCount: product.variants.length,
    image: product.images[0]?.src || null,
    imageAlt: product.images[0]?.alt || product.title,
    price: prices.length ? Math.min(...prices) : null,
    currency: 'AUD',
    publishedAt: product.published_at,
    variants: product.variants.map((variant) => ({ title: variant.title, sku: variant.sku || null, price: Number(variant.price), available: variant.available, options: [variant.option1, variant.option2, variant.option3].filter(Boolean) })),
    url: `https://${storefrontDomain}/products/${encodeURIComponent(product.handle)}`
  };
}

async function loadStoreDetails() {
  if (siteCache.value && siteCache.expiresAt > Date.now()) return siteCache.value;
  const response = await fetch(`https://${storefrontDomain}/`, { headers: { 'user-agent': 'PixMagic-live-dashboard/1.0' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Storefront returned ${response.status}`);
  const html = await response.text();
  const description = html.match(/<meta name="description" content="([^"]*)"/i)?.[1] || '';
  const logo = html.match(/"logo":"(https?:[^"\\]+(?:\\.[^"\\]+)*)"/i)?.[1]?.replace(/\\\//g, '/') || null;
  const socialLinks = [...html.matchAll(/"sameAs":\s*\[([^\]]*)\]/g)][0]?.[1]?.match(/https?:\\?\/\\?\/[^",]+/g)?.map((url) => url.replace(/\\\//g, '/')) || [];
  const policies = [...html.matchAll(/href="(\/policies\/[^"?#]+)"/g)].map((match) => `https://${storefrontDomain}${match[1]}`);
  siteCache.value = { name: 'PixMagic', description, logo, socialLinks: [...new Set(socialLinks)], policies: [...new Set(policies)] };
  siteCache.expiresAt = Date.now() + cacheTtlMs;
  return siteCache.value;
}

async function loadAdminSummary() {
  const domain = authorizedAdmin?.domain || process.env.SHOPIFY_ADMIN_DOMAIN;
  const token = authorizedAdmin?.token || await loadAdminAccessToken(domain);
  if (!domain || !token) return { connected: false, message: 'Connect an authorized Shopify Admin access token to show protected business data.' };
  const query = `query DashboardSummary { shop { name } productsCount { count } customersCount { count } ordersCount { count } locations(first: 20) { nodes { name } } }`;
  const response = await fetch(`https://${domain}/admin/api/2026-07/graphql.json`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  if (!response.ok || payload.errors) return { connected: false, message: payload.errors?.[0]?.message || 'The Admin connection could not be verified.' };
  const data = payload.data;
  return { connected: true, shop: data.shop.name, products: data.productsCount.count, customers: data.customersCount.count, orders: data.ordersCount.count, locations: data.locations.nodes.map((location) => location.name) };
}

async function adminGraphql(query, variables = {}) {
  const domain = authorizedAdmin?.domain || process.env.SHOPIFY_ADMIN_DOMAIN;
  const token = authorizedAdmin?.token || await loadAdminAccessToken(domain);
  if (!domain || !token) throw new Error('Connect an authorized Shopify Admin access token to show protected business data.');
  const response = await fetch(`https://${domain}/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(25_000)
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) throw new Error(payload.errors?.[0]?.message || 'Shopify Admin data could not be loaded.');
  return payload.data;
}

function money(value) {
  return Number(value?.amount || 0);
}

function unavailable(error) {
  return { available: false, message: error.message };
}

function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null; }

async function loadLiveAdminDashboard({ startDate = null, endDate = null } = {}) {
  try {
    const domain = authorizedAdmin?.domain || process.env.SHOPIFY_ADMIN_DOMAIN;
    await loadAdminAccessToken(domain);
    const overviewQuery = `query LiveOverview {
      shop { name currencyCode timezoneAbbreviation ianaTimezone primaryDomain { url } plan { displayName } }
      productsCount { count } customersCount { count } ordersCount { count }
      locations(first: 20) { nodes { id name } }
    }`;
    const ordersQuery = `query LiveOrders($query: String!) {
      orders(first: 50, reverse: true, sortKey: PROCESSED_AT, query: $query) {
        nodes { id name processedAt displayFinancialStatus displayFulfillmentStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          customer { id displayName }
          discountCodes
          lineItems(first: 50) { nodes { title quantity } }
        }
      }
    }`;
    const inventoryQuery = `query LiveInventory {
      inventoryItems(first: 50) { nodes { sku tracked product { title }
        inventoryLevels(first: 20) { nodes { quantities(names: [\"available\"]) { name quantity } location { name } } }
      } }
    }`;
    const orderFilter = [startDate && `processed_at:>=${startDate}`, endDate && `processed_at:<=${endDate}`].filter(Boolean).join(' ');
    const [overviewResult, orderResult, inventoryResult] = await Promise.allSettled([
      adminGraphql(overviewQuery), adminGraphql(ordersQuery, { query: orderFilter }), adminGraphql(inventoryQuery)
    ]);
    if (overviewResult.status === 'rejected') throw overviewResult.reason;
    const overview = overviewResult.value;
    const store = overview.shop;
    const report = {
      connected: true, available: true,
      store: {
        name: store.name, website: store.primaryDomain?.url || null, currency: store.currencyCode,
        timezone: store.timezoneAbbreviation || null, ianaTimezone: store.ianaTimezone || null, plan: store.plan?.displayName || null,
        locations: overview.locations.nodes.map(({ name }) => name)
      },
      totals: { products: overview.productsCount.count, customers: overview.customersCount.count, orders: overview.ordersCount.count },
      dateRange: { startDate, endDate },
      orders: orderResult.status === 'fulfilled' ? buildOrderReport(orderResult.value.orders.nodes) : unavailable(orderResult.reason),
      inventory: inventoryResult.status === 'fulfilled' ? buildInventoryReport(inventoryResult.value.inventoryItems.nodes) : unavailable(inventoryResult.reason)
    };
    return report;
  } catch (error) { return { connected: false, available: false, message: error.message }; }
}

function buildOrderReport(orders) {
  const now = Date.now();
  const days = new Map(); const customers = new Map(); const products = new Map();
  let revenue = 0; let paid = 0; let pending = 0; let refunded = 0; let discounted = 0;
  for (const order of orders) {
    const amount = money(order.currentTotalPriceSet?.shopMoney);
    revenue += amount;
    const financial = String(order.displayFinancialStatus || '').toLowerCase();
    if (financial === 'paid') paid += 1;
    else if (financial.includes('refund')) refunded += 1;
    else pending += 1;
    if (order.discountCodes?.length) discounted += 1;
    const date = order.processedAt?.slice(0, 10);
    if (date) days.set(date, (days.get(date) || 0) + amount);
    if (order.customer?.id) customers.set(order.customer.id, { name: order.customer.displayName || 'Customer', orders: (customers.get(order.customer.id)?.orders || 0) + 1, spend: (customers.get(order.customer.id)?.spend || 0) + amount });
    for (const item of order.lineItems.nodes) products.set(item.title, (products.get(item.title) || 0) + item.quantity);
  }
  const dateLimit = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString().slice(0, 10);
  const sumAfter = (date) => [...days].filter(([key]) => key >= date).reduce((sum, [, value]) => sum + value, 0);
  const customerValues = [...customers.values()];
  return {
    available: true, sampleSize: orders.length, revenue, orderCount: orders.length, averageOrderValue: orders.length ? revenue / orders.length : 0,
    statuses: { paid, pending, refunded }, discountOrders: discounted,
    trends: { daily: sumAfter(dateLimit(1)), weekly: sumAfter(dateLimit(7)), monthly: sumAfter(dateLimit(30)), days: [...days].sort(([a], [b]) => a.localeCompare(b)).slice(-14).map(([date, value]) => ({ date, value })) },
    customers: { newInSample: customerValues.filter((c) => c.orders === 1).length, returningInSample: customerValues.filter((c) => c.orders > 1).length, repeatPurchaseRate: customerValues.length ? customerValues.filter((c) => c.orders > 1).length / customerValues.length : 0, top: customerValues.sort((a, b) => b.spend - a.spend).slice(0, 5) },
    bestSellers: [...products].map(([title, quantity]) => ({ title, quantity })).sort((a, b) => b.quantity - a.quantity).slice(0, 5),
    recent: orders.slice(0, 10).map((order) => ({ name: order.name, processedAt: order.processedAt, total: money(order.currentTotalPriceSet?.shopMoney), financialStatus: order.displayFinancialStatus, fulfillmentStatus: order.displayFulfillmentStatus }))
  };
}

function buildInventoryReport(items) {
  const rows = items.flatMap((item) => item.inventoryLevels.nodes.map((level) => ({ product: item.product?.title || 'Unlinked product', sku: item.sku || null, location: level.location?.name || 'Unknown location', available: level.quantities.find((quantity) => quantity.name === 'available')?.quantity ?? 0 })));
  return { available: true, sampledItems: items.length, rows, lowStock: rows.filter((row) => row.available > 0 && row.available <= 5), outOfStock: rows.filter((row) => row.available <= 0) };
}

async function loadAdminAccessToken(domain) {
  if (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) return process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (adminTokenCache.value && adminTokenCache.expiresAt > Date.now()) return adminTokenCache.value;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!domain || !clientId || !clientSecret) return null;
  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || 'Shopify did not issue an Admin access token.');
  adminTokenCache.value = payload.access_token;
  adminTokenCache.expiresAt = Date.now() + Math.max((Number(payload.expires_in) || 86_400) - 60, 60) * 1_000;
  return adminTokenCache.value;
}

function safeShop(value) {
  const shop = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

function appUrl(request) {
  return (process.env.APP_URL || `http://${request.headers.host}`).replace(/\/$/, '');
}

function connection(name, configured) {
  return { name, connected: configured, message: configured ? 'Credentials configured. Live sync can be enabled for this account.' : 'Connection required' };
}

async function loadProducts() {
  if (cache.value && cache.expiresAt > Date.now()) return cache.value;
  const products = [];
  let nextUrl = `https://${storefrontDomain}/products.json?limit=250`;
  while (nextUrl) {
    const upstream = await fetch(nextUrl, {
      headers: { accept: 'application/json', 'user-agent': 'PixMagic-live-catalog/1.0' },
      signal: AbortSignal.timeout(15_000)
    });
    if (!upstream.ok) throw new Error(`Storefront returned ${upstream.status}`);
    const body = await upstream.json();
    const pageProducts = Array.isArray(body.products) ? body.products : [];
    products.push(...pageProducts.map(toProduct));
    const links = upstream.headers.get('link') || '';
    nextUrl = links.match(/<([^>]+)>; rel="next"/)?.[1] || null;
  }
  cache.value = products;
  cache.expiresAt = Date.now() + cacheTtlMs;
  return products;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'GET' && url.pathname === '/api/products') {
    try {
      const products = await loadProducts();
      const query = (url.searchParams.get('q') || '').trim().toLowerCase();
      const type = (url.searchParams.get('type') || '').trim().toLowerCase();
      const filtered = products.filter((product) =>
        (!query || [product.title, product.type, product.vendor].join(' ').toLowerCase().includes(query)) &&
        (!type || product.type.toLowerCase() === type)
      );
      json(response, 200, { source: storefrontDomain, fetchedAt: new Date().toISOString(), total: filtered.length, products: filtered });
    } catch (error) {
      json(response, 502, { error: 'Could not load the live storefront catalog.', detail: error.message });
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/dashboard') {
    try {
      const startDate = validDate(url.searchParams.get('start'));
      const endDate = validDate(url.searchParams.get('end'));
      if (url.searchParams.get('start') && !startDate || url.searchParams.get('end') && !endDate || startDate && endDate && startDate > endDate) return json(response, 400, { error: 'Choose a valid date range where the start date is before the end date.' });
      const [products, store, live] = await Promise.all([loadProducts(), loadStoreDetails(), loadLiveAdminDashboard({ startDate, endDate })]);
      const types = [...new Set(products.map((product) => product.type))].sort();
      const available = products.filter((product) => product.available).length;
      const variants = products.reduce((total, product) => total + product.variantCount, 0);
      json(response, 200, { source: storefrontDomain, fetchedAt: new Date().toISOString(), store, live, metrics: { products: products.length, categories: types.length, variants, available }, categories: types, products });
    } catch (error) { json(response, 502, { error: 'Could not load the live storefront dashboard.', detail: error.message }); }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/insights') {
    const admin = await loadAdminSummary();
    json(response, 200, {
      fetchedAt: new Date().toISOString(), admin,
      integrations: [
        connection('Shopify Admin', Boolean(process.env.SHOPIFY_ADMIN_DOMAIN && (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || (process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET)))),
        connection('Meta Ads & Instagram', Boolean(process.env.META_AD_ACCOUNT_ID && process.env.META_ACCESS_TOKEN)),
        connection('Google Ads', Boolean(process.env.GOOGLE_ADS_CUSTOMER_ID && process.env.GOOGLE_ADS_REFRESH_TOKEN)),
        connection('TikTok Ads', Boolean(process.env.TIKTOK_ADVERTISER_ID && process.env.TIKTOK_ACCESS_TOKEN))
      ]
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/shopify') {
    const shop = safeShop(url.searchParams.get('shop'));
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    if (!shop || !clientId || !process.env.SHOPIFY_CLIENT_SECRET) return json(response, 400, { error: 'Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env, then enter a valid .myshopify.com store domain.' });
    const state = randomBytes(24).toString('hex');
    oauthStates.add(state);
    const callback = `${appUrl(request)}/auth/shopify/callback`;
    const scopes = 'read_products,read_customers,read_orders,read_locations,read_inventory,read_markets_home';
    response.writeHead(302, { location: `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(callback)}&state=${state}` });
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/auth/shopify/callback') {
    const shop = safeShop(url.searchParams.get('shop'));
    const state = url.searchParams.get('state');
    const hmac = url.searchParams.get('hmac');
    const values = [...url.searchParams.entries()].filter(([key]) => key !== 'hmac' && key !== 'signature').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
    const expected = createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET || '').update(values).digest('hex');
    const validHmac = hmac && hmac.length === expected.length && timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
    if (!shop || !state || !oauthStates.delete(state) || !validHmac) return json(response, 401, { error: 'The Shopify authorization response could not be verified.' });
    try {
      const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET, code: url.searchParams.get('code') }), signal: AbortSignal.timeout(15_000) });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || 'Token exchange failed.');
      authorizedAdmin = { domain: shop, token: token.access_token };
      response.writeHead(302, { location: '/#business' }); response.end();
    } catch (error) { json(response, 502, { error: 'Shopify authorization could not be completed.', detail: error.message }); }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, source: storefrontDomain });

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return json(response, 403, { error: 'Forbidden' });
  try {
    const content = await readFile(filePath);
    response.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
});

server.listen(port, () => console.log(`Live catalog available at http://localhost:${port}`));
