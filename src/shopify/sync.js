import { db } from '../database/db.js';
import { log } from '../logger.js';
import { syncStore, getStore } from './store.js';
import { syncOrders } from './orders.js';
import { syncCustomers } from './customers.js';
import { syncProducts, syncVariants } from './products.js';
import { syncInventory } from './inventory.js';
import { cache } from '../cache.js';

const INVENTORY_FULL_REFRESH_MS = 6 * 60 * 60 * 1000; // webhooks keep it current in between
const running = new Map();
export const progress = new Map();

function state(shop, resource) {
  return db.prepare('SELECT * FROM sync_state WHERE shop = ? AND resource = ?').get(shop, resource);
}

function saveState(shop, resource, fields) {
  const current = state(shop, resource) || {};
  const next = { ...current, ...fields };
  db.prepare(`INSERT INTO sync_state (shop, resource, last_updated_at, last_full_sync_at, last_run_at, complete, record_count, error)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(shop, resource) DO UPDATE SET last_updated_at=excluded.last_updated_at,
    last_full_sync_at=excluded.last_full_sync_at, last_run_at=excluded.last_run_at, complete=excluded.complete,
    record_count=excluded.record_count, error=excluded.error`)
    .run(shop, resource, next.last_updated_at ?? null, next.last_full_sync_at ?? null, next.last_run_at ?? null, next.complete ?? 0, next.record_count ?? null, next.error ?? null);
}

async function runResource(shop, resource, work, { full }) {
  const previous = state(shop, resource);
  // Incremental only after a complete full pass; otherwise start over so history is never silently partial.
  const since = !full && previous?.complete ? previous.last_updated_at : null;
  const started = new Date().toISOString();
  progress.set(`${shop}:${resource}`, { resource, mode: since ? 'incremental' : 'full', fetched: 0, startedAt: started });
  try {
    const result = await work(since, (fetched) => progress.set(`${shop}:${resource}`, { resource, mode: since ? 'incremental' : 'full', fetched, startedAt: started }));
    saveState(shop, resource, {
      last_updated_at: result.latest ?? previous?.last_updated_at ?? null, last_run_at: started, complete: 1, error: null,
      ...(since ? {} : { last_full_sync_at: started, record_count: result.count })
    });
    // Incremental queries use updated_at >= last seen, so a changed record moves `latest` forward.
    const changed = !since || (result.latest && result.latest !== previous?.last_updated_at);
    if (changed) log.info('sync.resource.done', { shop, resource, mode: since ? 'incremental' : 'full', records: result.count });
    return changed;
  } catch (error) {
    saveState(shop, resource, { last_run_at: started, error: `${error.category || 'error'}: ${error.message}`, ...(since || previous?.complete ? {} : { complete: 0 }) }); // keep the last complete snapshot usable
    log.error('sync.resource.failed', { shop, resource, category: error.category, error: error.message });
  } finally {
    progress.delete(`${shop}:${resource}`);
  }
}

// Data version: bumps whenever synced data actually changes, so dashboards can poll cheaply
// and only reload (and only drop cached Shopify report results) when there is something new.
const versions = new Map();
export function dataVersion(shop) { return versions.get(shop) || 0; }
export function markChanged(shop) {
  versions.set(shop, dataVersion(shop) + 1);
  cache.clear(shop);
}

const STORE_REFRESH_MS = 10 * 60 * 1000;
const lastStoreSync = new Map();
const inventoryJobs = new Map();

// Inventory full refresh is slow (tens of thousands of items), so it runs on its own lock and
// never blocks the frequent order/customer/product sync.
function syncInventoryJob(shop, { full }) {
  if (inventoryJobs.has(shop)) return inventoryJobs.get(shop);
  const inventory = state(shop, 'inventory');
  if (!full && inventory?.complete && Date.now() - Date.parse(inventory.last_full_sync_at || 0) <= INVENTORY_FULL_REFRESH_MS) return null;
  const job = runResource(shop, 'inventory', (_since, onPage) => syncInventory(shop, { onPage }), { full: true })
    .then((changed) => { if (changed) markChanged(shop); })
    .finally(() => inventoryJobs.delete(shop));
  inventoryJobs.set(shop, job);
  return job;
}

export function syncShop(shop, { full = false } = {}) {
  syncInventoryJob(shop, { full });
  if (running.has(shop)) return running.get(shop);
  const job = (async () => {
    try {
      if (full || !getStore(shop) || Date.now() - (lastStoreSync.get(shop) || 0) > STORE_REFRESH_MS) {
        await syncStore(shop);
        lastStoreSync.set(shop, Date.now());
      }
      const timeZone = getStore(shop)?.iana_timezone || 'UTC';
      const changes = [
        await runResource(shop, 'orders', (since, onPage) => syncOrders(shop, { since, timeZone, onPage }), { full }),
        await runResource(shop, 'customers', (since, onPage) => syncCustomers(shop, { since, timeZone, onPage }), { full }),
        await runResource(shop, 'products', (since, onPage) => syncProducts(shop, { since, onPage }), { full }),
        await runResource(shop, 'variants', (since, onPage) => syncVariants(shop, { since, onPage }), { full })
      ];
      if (changes.some(Boolean)) markChanged(shop);
    } catch (error) {
      log.error('sync.failed', { shop, category: error.category, error: error.message });
      throw error;
    } finally {
      running.delete(shop);
    }
  })();
  running.set(shop, job);
  job.catch(() => {});
  return job;
}

export function syncStatus(shop) {
  return {
    running: running.has(shop) || inventoryJobs.has(shop),
    dataVersion: dataVersion(shop),
    inProgress: [...progress.entries()].filter(([key]) => key.startsWith(`${shop}:`)).map(([, value]) => value),
    resources: db.prepare('SELECT resource, last_updated_at, last_full_sync_at, last_run_at, complete, record_count, error FROM sync_state WHERE shop = ?').all(shop)
      .map((row) => ({ ...row, complete: Boolean(row.complete) }))
  };
}

export function isComplete(shop, resource) {
  return Boolean(state(shop, resource)?.complete);
}
