import { db, localDate } from '../database/db.js';
import { getStore } from '../shopify/store.js';

// First-party storefront events sent by the custom web pixel (see pixel/web-pixel.js).
// This data is self-reported by browsers: it is stored and reported separately from Shopify order data.
export const TRACKED_EVENTS = ['page_viewed', 'product_viewed', 'product_added_to_cart', 'checkout_started', 'payment_info_submitted', 'checkout_completed'];

export function recordEvent(shop, body) {
  const events = Array.isArray(body?.events) ? body.events.slice(0, 50) : [body];
  const tz = getStore(shop)?.iana_timezone || 'UTC';
  const insert = db.prepare(`INSERT OR IGNORE INTO tracking_events (event_id, shop, name, client_id, occurred_at, local_date, product_id, received_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  let accepted = 0;
  for (const event of events) {
    if (!event || !TRACKED_EVENTS.includes(event.name)) continue;
    const id = String(event.id || '').slice(0, 100);
    const occurred = Date.parse(event.timestamp);
    if (!id || !Number.isFinite(occurred) || Math.abs(Date.now() - occurred) > 48 * 3600_000) continue;
    const iso = new Date(occurred).toISOString();
    const result = insert.run(id, shop, event.name, String(event.clientId || '').slice(0, 100) || null, iso, localDate(iso, tz), event.productId ? String(event.productId).slice(0, 100) : null, new Date().toISOString());
    accepted += Number(result.changes);
  }
  return accepted;
}

export function trackingFunnel(shop, { startDate, endDate }) {
  const rows = db.prepare(`SELECT name, COUNT(*) AS events, COUNT(DISTINCT client_id) AS visitors FROM tracking_events
    WHERE shop = ? AND local_date BETWEEN ? AND ? GROUP BY name`).all(shop, startDate, endDate);
  const byName = new Map(rows.map((row) => [row.name, row]));
  const visitors = db.prepare('SELECT COUNT(DISTINCT client_id) AS count FROM tracking_events WHERE shop = ? AND local_date BETWEEN ? AND ?').get(shop, startDate, endDate).count;
  return {
    available: rows.length > 0,
    steps: [
      { key: 'visitors', label: 'Visitors', value: rows.length ? visitors : null },
      ...TRACKED_EVENTS.slice(1).map((name) => ({ key: name, label: name.replace(/_/g, ' '), value: byName.get(name)?.visitors ?? (rows.length ? 0 : null) }))
    ]
  };
}
