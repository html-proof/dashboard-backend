import { createServer } from 'node:http';
import { assertConfig, config } from './config.js';
import { log } from './logger.js';
import { handle } from './app.js';
import { markChanged, syncShop } from './shopify/sync.js';
import { getStore } from './shopify/store.js';
import { localDate } from './database/db.js';
import { metaConfigured, syncMetaSpend } from './ads/meta.js';
import { registerWebhooks } from './shopify/webhooks.js';
import { connectedShops } from './auth/session.js';

const problems = assertConfig();
if (config.isProduction && !config.dashboardApiKey) problems.push('DASHBOARD_API_KEY is required in production');
if (problems.length) {
  for (const problem of problems) log.error('config.invalid', { problem });
  process.exit(1);
}

const server = createServer(handle);
server.requestTimeout = 30_000;
server.listen(config.port, () => {
  log.info('server.started', { url: config.appUrl, shop: config.shopify.store, apiVersion: config.shopify.apiVersion });
  // Every store that has connected (plus SHOPIFY_STORE, if set) is kept in sync. Stores that connect later
  // are picked up on the next tick; webhooks keep data fresh between runs.
  const registered = new Set();
  const syncAll = () => {
    for (const shop of connectedShops()) {
      syncShop(shop).catch(() => {});
      if (!registered.has(shop)) {
        registered.add(shop);
        registerWebhooks(shop).then((result) => log.info('webhooks.status', { shop, ...result })).catch((error) => log.warn('webhooks.register_failed', { shop, error: error.message }));
      }
    }
  };
  syncAll();
  setInterval(syncAll, config.syncIntervalSeconds * 1000).unref();
  // Ad spend: Meta reports with some delay, so hourly is enough (the last 7 days are re-read each time).
  const syncAds = async () => {
    for (const shop of connectedShops()) {
      if (!metaConfigured(shop)) continue;
      const tz = getStore(shop)?.iana_timezone || 'UTC';
      if (await syncMetaSpend(shop, { today: localDate(new Date().toISOString(), tz) })) markChanged(shop);
    }
  };
  setTimeout(syncAds, 30_000); setInterval(syncAds, 60 * 60_000).unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { log.info('server.stopping', { signal }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
