import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal .env loader (no dependency). Real environment variables win over .env values.
try {
  const source = readFileSync(join(process.cwd(), '.env'), 'utf8');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* .env is optional in production, where the platform injects variables */ }

const env = process.env;

function shopDomain(value) {
  const shop = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

export const config = {
  port: Number(env.PORT || 3000),
  appUrl: (env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  isProduction: env.NODE_ENV === 'production',
  storefrontDomain: env.SHOPIFY_STOREFRONT_DOMAIN || null,
  shopify: {
    clientId: env.SHOPIFY_CLIENT_ID || '',
    clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
    // SHOPIFY_STORE is preferred; SHOPIFY_ADMIN_DOMAIN is kept for older .env files.
    store: shopDomain(env.SHOPIFY_STORE || env.SHOPIFY_ADMIN_DOMAIN),
    apiVersion: env.SHOPIFY_API_VERSION || '2026-07',
    scopes: env.SHOPIFY_SCOPES || 'read_orders,read_all_orders,read_customers,read_products,read_inventory,read_locations,read_fulfillments,read_reports',
    // Legacy static Admin token. Supported, but OAuth/client-credentials tokens are preferred.
    staticAccessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN || ''
  },
  databaseUrl: env.DATABASE_URL || 'file:data/app.db',
  tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY || '',
  dashboardApiKey: env.DASHBOARD_API_KEY || '',
  // Incremental sync cadence. Each run is a few cheap GraphQL calls (well inside Shopify's rate limits).
  syncIntervalSeconds: Math.max(5, Number(env.SYNC_INTERVAL_SECONDS || 10)),
  requestTimeoutMs: Number(env.SHOPIFY_TIMEOUT_MS || 25_000)
};

export { shopDomain };

export function assertConfig() {
  const problems = [];
  if (!config.shopify.clientId) problems.push('SHOPIFY_CLIENT_ID is not set');
  if (!config.shopify.clientSecret) problems.push('SHOPIFY_CLIENT_SECRET is not set');
  if (!/^[0-9a-f]{64}$/i.test(config.tokenEncryptionKey)) problems.push('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  if (config.isProduction && !config.appUrl.startsWith('https://')) problems.push('APP_URL must use https:// in production');
  return problems;
}
