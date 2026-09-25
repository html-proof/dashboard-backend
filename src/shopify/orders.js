import { db, localDate, transaction } from '../database/db.js';
import { graphql, paginate } from './client.js';

// Refunds and fulfillment status are fetched as part of each order so one sync keeps them consistent.
const ORDER_FIELDS = `
  id name createdAt processedAt updatedAt cancelledAt cancelReason test sourceName
  app { name }
  displayFinancialStatus displayFulfillmentStatus
  customer { id displayName }
  totalDiscountsSet { shopMoney { amount } }
  totalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  totalPriceSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
  totalRefundedSet { shopMoney { amount } }
  shippingAddress { provinceCode countryCode }
  retailLocation { name }
  refunds(first: 50) { id createdAt totalRefundedSet { shopMoney { amount } } }
  transactions(first: 5) { kind status gateway fees { amount { amount } } }
  lineItems(first: 50) {
    pageInfo { hasNextPage endCursor }
    nodes { id title variantTitle sku quantity currentQuantity variant { id } product { id }
      originalTotalSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } } }
  }`;

const ORDERS_QUERY = `query SyncOrders($after: String, $query: String) {
  orders(first: 40, after: $after, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`;

const ORDER_QUERY = `query OrderById($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

const MORE_LINE_ITEMS = `query MoreLineItems($id: ID!, $after: String) { order(id: $id) {
  lineItems(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
    nodes { id title variantTitle sku quantity currentQuantity variant { id } product { id }
      originalTotalSet { shopMoney { amount } } totalDiscountSet { shopMoney { amount } } } } } }`;

const amount = (set) => (set?.shopMoney?.amount == null ? 0 : Number(set.shopMoney.amount));

async function completeLineItems(shop, order) {
  const items = [...order.lineItems.nodes];
  let { hasNextPage, endCursor } = order.lineItems.pageInfo;
  while (hasNextPage) {
    const data = await graphql(shop, MORE_LINE_ITEMS, { id: order.id, after: endCursor }, { operation: 'orderLineItems' });
    items.push(...data.order.lineItems.nodes);
    ({ hasNextPage, endCursor } = data.order.lineItems.pageInfo);
  }
  return items;
}

// Processing fees Shopify reports on successful transactions (Shopify Payments). Other gateways
// (PayPal, Afterpay, ...) charge outside Shopify and report no fees here.
function paymentFees(order) {
  const ok = (order.transactions || []).filter((t) => t.status === 'SUCCESS' && ['SALE', 'CAPTURE', 'REFUND'].includes(t.kind));
  const total = ok.reduce((sum, t) => sum + (t.fees || []).reduce((s, f) => s + Number(f.amount?.amount || 0), 0), 0);
  return { total, gateways: [...new Set(ok.map((t) => t.gateway).filter(Boolean))].join(',') || null };
}

export function saveOrder(shop, order, items, timeZone) {
  const fees = paymentFees(order);
  const gross = items.reduce((sum, item) => sum + amount(item.originalTotalSet), 0);
  const units = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  transaction(() => {
    db.prepare(`INSERT INTO orders (id, shop, name, created_at, processed_at, updated_at, local_date, cancelled_at, cancel_reason, test,
        source_name, channel, financial_status, fulfillment_status, customer_id, customer_name, units, gross, discounts, tax, shipping,
        total, current_total, refunded, province, country, retail_location, payment_fees, gateways)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, processed_at=excluded.processed_at, updated_at=excluded.updated_at,
        local_date=excluded.local_date, cancelled_at=excluded.cancelled_at, cancel_reason=excluded.cancel_reason, test=excluded.test,
        source_name=excluded.source_name, channel=excluded.channel, financial_status=excluded.financial_status,
        fulfillment_status=excluded.fulfillment_status, customer_id=excluded.customer_id, customer_name=excluded.customer_name,
        units=excluded.units, gross=excluded.gross, discounts=excluded.discounts, tax=excluded.tax, shipping=excluded.shipping,
        total=excluded.total, current_total=excluded.current_total, refunded=excluded.refunded, province=excluded.province,
        country=excluded.country, retail_location=excluded.retail_location, payment_fees=excluded.payment_fees, gateways=excluded.gateways`)
      .run(order.id, shop, order.name, order.createdAt, order.processedAt, order.updatedAt, localDate(order.processedAt, timeZone),
        order.cancelledAt, order.cancelReason, order.test ? 1 : 0, order.sourceName, order.app?.name || order.sourceName || null,
        order.displayFinancialStatus, order.displayFulfillmentStatus, order.customer?.id || null, order.customer?.displayName || null,
        units, gross, amount(order.totalDiscountsSet), amount(order.totalTaxSet), amount(order.totalShippingPriceSet),
        amount(order.totalPriceSet), amount(order.currentTotalPriceSet), amount(order.totalRefundedSet),
        order.shippingAddress?.provinceCode || null, order.shippingAddress?.countryCode || null, order.retailLocation?.name || null,
        fees.total, fees.gateways);

    db.prepare('DELETE FROM order_line_items WHERE order_id = ?').run(order.id);
    const insertItem = db.prepare(`INSERT INTO order_line_items (id, order_id, product_id, variant_id, title, variant_title, sku, quantity, current_quantity, gross, discount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of items) {
      insertItem.run(item.id, order.id, item.product?.id || null, item.variant?.id || null, item.title, item.variantTitle || null, item.sku || null,
        item.quantity, item.currentQuantity, amount(item.originalTotalSet), amount(item.totalDiscountSet));
    }
    db.prepare('DELETE FROM refunds WHERE order_id = ?').run(order.id);
    const insertRefund = db.prepare('INSERT INTO refunds (id, order_id, shop, created_at, local_date, amount) VALUES (?,?,?,?,?,?)');
    for (const refund of order.refunds || []) insertRefund.run(refund.id, order.id, shop, refund.createdAt, localDate(refund.createdAt, timeZone), amount(refund.totalRefundedSet));
  });
}

export async function syncOrders(shop, { since, timeZone, onPage }) {
  let count = 0; let latest = since;
  const query = since ? `updated_at:>='${since}'` : null;
  for await (const nodes of paginate(shop, ORDERS_QUERY, { query }, (data) => data.orders, { operation: 'syncOrders', expectedCost: 700 })) {
    for (const order of nodes) {
      const items = order.lineItems.pageInfo.hasNextPage ? await completeLineItems(shop, order) : order.lineItems.nodes;
      saveOrder(shop, order, items, timeZone);
      if (!latest || order.updatedAt > latest) latest = order.updatedAt;
    }
    count += nodes.length;
    onPage?.(count);
  }
  return { count, latest };
}

export async function refreshOrder(shop, id, timeZone) {
  const data = await graphql(shop, ORDER_QUERY, { id }, { operation: 'orderById' });
  if (!data.order) { db.prepare('DELETE FROM orders WHERE id = ?').run(id); return null; }
  const items = data.order.lineItems.pageInfo.hasNextPage ? await completeLineItems(shop, data.order) : data.order.lineItems.nodes;
  saveOrder(shop, data.order, items, timeZone);
  return data.order;
}
