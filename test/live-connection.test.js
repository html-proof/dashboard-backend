import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function loadLocalEnv() {
  try {
    const source = await readFile(join(process.cwd(), '.env'), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // A .env file is optional: public-storefront testing still works without it.
  }
}

await loadLocalEnv();

const storefrontDomain = process.env.SHOPIFY_STOREFRONT_DOMAIN || 'www.pixmagic.com.au';
const adminDomain = process.env.SHOPIFY_ADMIN_DOMAIN;
const adminToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

test('public Shopify catalogue can be fetched', async () => {
  const response = await fetch(`https://${storefrontDomain}/products.json?limit=1`, {
    headers: { accept: 'application/json', 'user-agent': 'PixMagic-live-connection-test/1.0' },
    signal: AbortSignal.timeout(15_000)
  });

  assert.equal(response.ok, true, `Storefront returned HTTP ${response.status}`);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.products), 'Storefront response must include a products array');
  console.log(`Public storefront connected: ${payload.products.length} product record(s) returned.`);
});

test('Shopify Admin API can fetch protected summary data', { skip: !(adminDomain && (adminToken || (clientId && clientSecret))) }, async () => {
  assert.match(adminDomain, /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i, 'SHOPIFY_ADMIN_DOMAIN must be a valid .myshopify.com domain');
  let accessToken = adminToken;
  if (!accessToken) {
    const tokenResponse = await fetch(`https://${adminDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(15_000)
    });
    const tokenPayload = await tokenResponse.json();
    assert.equal(tokenResponse.ok, true, `Token exchange returned HTTP ${tokenResponse.status}`);
    assert.ok(tokenPayload.access_token, 'Shopify did not issue an Admin access token');
    accessToken = tokenPayload.access_token;
  }
  const query = 'query ConnectionTest { shop { name } productsCount { count } }';
  const response = await fetch(`https://${adminDomain}/admin/api/2026-07/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json();

  assert.equal(response.ok, true, `Admin API returned HTTP ${response.status}`);
  assert.equal(payload.errors, undefined, `Admin API error: ${payload.errors?.[0]?.message || 'unknown error'}`);
  assert.ok(payload.data?.shop?.name, 'Admin API response must include the shop name');
  console.log(`Shopify Admin connected: ${payload.data.shop.name}; ${payload.data.productsCount.count} product(s).`);
});
