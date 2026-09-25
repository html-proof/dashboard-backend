import { config, shopDomain } from '../config.js';
import { db, transaction } from '../database/db.js';
import { verifyWebhookHmac } from '../auth/crypto.js';
import { revokeToken } from '../auth/token_service.js';
import { assertNoUserErrors, graphql } from './client.js';
import { getStore } from './store.js';
import { refreshOrder } from './orders.js';
import { deleteCustomer, refreshCustomer } from './customers.js';
import { deleteProduct, refreshProduct } from './products.js';
import { deleteInventoryLevel, saveInventoryLevel } from './inventory.js';
import { markChanged } from './sync.js';
import { log } from '../logger.js';

export const TOPICS = [
  'orders/create', 'orders/updated', 'orders/cancelled', 'orders/paid', 'orders/fulfilled', 'orders/partially_fulfilled',
  'refunds/create', 'fulfillments/create', 'fulfillments/update',
  'customers/create', 'customers/update', 'customers/delete',
  'products/create', 'products/update', 'products/delete',
  'inventory_levels/update', 'inventory_levels/disconnect', 'app/uninstalled'
];
// Mandatory privacy topics are configured in the app's Partner/Dev Dashboard config, not registered via API.
export const COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'];

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);

const handlers = {
  order: (shop, payload, tz) => refreshOrder(shop, gid('Order', payload.admin_graphql_api_id || payload.id), tz),
  byOrderId: (shop, payload, tz) => refreshOrder(shop, gid('Order', payload.order_id), tz),
  customer: (shop, payload, tz) => refreshCustomer(shop, gid('Customer', payload.admin_graphql_api_id || payload.id), tz),
  product: (shop, payload) => refreshProduct(shop, gid('Product', payload.admin_graphql_api_id || payload.id))
};

const routes = {
  'orders/create': handlers.order, 'orders/updated': handlers.order, 'orders/cancelled': handlers.order, 'orders/paid': handlers.order,
  'orders/fulfilled': handlers.order, 'orders/partially_fulfilled': handlers.order,
  'refunds/create': handlers.byOrderId, 'fulfillments/create': handlers.byOrderId, 'fulfillments/update': handlers.byOrderId,
  'customers/create': handlers.customer, 'customers/update': handlers.customer,
  'customers/delete': (_shop, payload) => deleteCustomer(gid('Customer', payload.id)),
  'products/create': handlers.product, 'products/update': handlers.product,
  'products/delete': (_shop, payload) => deleteProduct(gid('Product', payload.id)),
  'inventory_levels/update': (shop, payload) => saveInventoryLevel(shop, {
    inventoryItemId: gid('InventoryItem', payload.inventory_item_id), locationId: gid('Location', payload.location_id),
    available: payload.available ?? null, updatedAt: payload.updated_at || new Date().toISOString()
  }),
  'inventory_levels/disconnect': (_shop, payload) => deleteInventoryLevel(gid('InventoryItem', payload.inventory_item_id), gid('Location', payload.location_id)),
  'app/uninstalled': (shop) => revokeToken(shop, 'app/uninstalled webhook'),
  // We store no email/phone/address. Name-level data is returned by Shopify's own export; nothing extra to report.
  'customers/data_request': (shop, payload) => log.info('compliance.data_request', { shop, customer: payload.customer?.id }),
  'customers/redact': (_shop, payload) => deleteCustomer(gid('Customer', payload.customer?.id)),
  'shop/redact': (shop) => transaction(() => {
    for (const table of ['orders', 'refunds', 'customers', 'products', 'variants', 'inventory_levels', 'locations', 'tracking_events', 'sync_state', 'access_tokens', 'shops']) {
      db.prepare(`DELETE FROM ${table} WHERE shop = ?`).run(shop);
    }
  })
};

export class WebhookError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// Verifies, de-duplicates and records the event. Returns a function that performs the (slower) processing,
// so the HTTP layer can acknowledge Shopify within its 5s window before doing the work.
export function acceptWebhook(rawBody, headers) {
  if (!verifyWebhookHmac(rawBody, headers['x-shopify-hmac-sha256'])) throw new WebhookError('Invalid webhook signature', 401);
  const topic = String(headers['x-shopify-topic'] || '');
  const shop = shopDomain(headers['x-shopify-shop-domain']);
  const eventId = headers['x-shopify-event-id'] || headers['x-shopify-webhook-id'];
  if (!shop || !topic || !eventId) throw new WebhookError('Missing Shopify webhook headers', 400);
  if (!routes[topic]) return { duplicate: false, ignored: true, process: async () => {} };

  const existing = db.prepare('SELECT status FROM webhook_events WHERE event_id = ?').get(eventId);
  if (existing && existing.status !== 'failed') return { duplicate: true, process: async () => {} };
  db.prepare(`INSERT INTO webhook_events (event_id, topic, shop, received_at, status) VALUES (?,?,?,?, 'received')
    ON CONFLICT(event_id) DO UPDATE SET status='received', error=NULL`).run(eventId, topic, shop, new Date().toISOString());

  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch { throw new WebhookError('Webhook body is not JSON', 400); }

  return {
    duplicate: false,
    process: async () => {
      try {
        await routes[topic](shop, payload, getStore(shop)?.iana_timezone || 'UTC');
        db.prepare("UPDATE webhook_events SET status='processed', processed_at=? WHERE event_id=?").run(new Date().toISOString(), eventId);
        markChanged(shop);
        log.info('webhook.processed', { shop, topic, eventId });
      } catch (error) {
        db.prepare("UPDATE webhook_events SET status='failed', error=? WHERE event_id=?").run(`${error.category || 'error'}: ${error.message}`, eventId);
        log.error('webhook.failed', { shop, topic, eventId, category: error.category, error: error.message });
      }
    }
  };
}

const LIST = `query Subs { webhookSubscriptions(first: 100) { nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`;
const CREATE = `mutation Sub($topic: WebhookSubscriptionTopic!, $url: URL!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) { webhookSubscription { id } userErrors { field message } } }`;

// Shopify only delivers to public HTTPS endpoints, so registration is skipped for localhost.
export async function registerWebhooks(shop) {
  const url = `${config.appUrl}/shopify/webhooks`;
  if (!url.startsWith('https://') || /localhost|127\.0\.0\.1/.test(url)) return { registered: [], skipped: 'APP_URL is not a public HTTPS URL; relying on scheduled incremental sync.' };
  const existing = await graphql(shop, LIST, {}, { operation: 'listWebhooks' });
  const have = new Set(existing.webhookSubscriptions.nodes.filter((node) => node.endpoint?.callbackUrl === url).map((node) => node.topic));
  const registered = []; const failed = [];
  for (const topic of TOPICS) {
    const enumTopic = topic.toUpperCase().replace('/', '_');
    if (have.has(enumTopic)) continue;
    try {
      const result = await graphql(shop, CREATE, { topic: enumTopic, url }, { operation: 'webhookSubscriptionCreate' });
      assertNoUserErrors(result.webhookSubscriptionCreate, `webhook ${topic}`);
      registered.push(topic);
    } catch (error) { failed.push({ topic, error: error.message }); }
  }
  log.info('webhooks.registered', { shop, registered: registered.length, failed: failed.length });
  return { registered, failed, alreadyPresent: [...have] };
}
