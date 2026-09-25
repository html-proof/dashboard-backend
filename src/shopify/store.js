import { db, transaction } from '../database/db.js';
import { graphql } from './client.js';

const STORE = `query StoreInfo {
  shop { name currencyCode ianaTimezone myshopifyDomain primaryDomain { host url } plan { displayName } }
  locations(first: 100, includeInactive: true) { nodes { id name isActive } }
  currentAppInstallation { accessScopes { handle } } }`;

export async function syncStore(shop) {
  const data = await graphql(shop, STORE, {}, { operation: 'storeInfo' });
  const s = data.shop;
  transaction(() => {
    db.prepare(`INSERT INTO shops (shop, name, currency, iana_timezone, primary_domain, myshopify_domain, plan, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(shop) DO UPDATE SET name=excluded.name, currency=excluded.currency, iana_timezone=excluded.iana_timezone,
      primary_domain=excluded.primary_domain, myshopify_domain=excluded.myshopify_domain, plan=excluded.plan, updated_at=excluded.updated_at`)
      .run(shop, s.name, s.currencyCode, s.ianaTimezone, s.primaryDomain?.host || null, s.myshopifyDomain, s.plan?.displayName || null, new Date().toISOString());
    db.prepare('DELETE FROM locations WHERE shop = ?').run(shop);
    const insert = db.prepare('INSERT INTO locations (id, shop, name, active) VALUES (?,?,?,?)');
    for (const location of data.locations.nodes) insert.run(location.id, shop, location.name, location.isActive ? 1 : 0);
  });
  return { ...s, scopes: data.currentAppInstallation.accessScopes.map((scope) => scope.handle) };
}

export function getStore(shop) {
  return db.prepare('SELECT * FROM shops WHERE shop = ?').get(shop) || null;
}
