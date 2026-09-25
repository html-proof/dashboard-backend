import { db, localDate } from '../database/db.js';
import { graphql, paginate } from './client.js';

// Only the fields the dashboard needs. Email, phone and addresses are deliberately not stored.
const FIELDS = 'id displayName createdAt updatedAt numberOfOrders amountSpent { amount } lastOrder { processedAt } state';
const LIST = `query SyncCustomers($after: String, $query: String) {
  customers(first: 100, after: $after, sortKey: UPDATED_AT, query: $query) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`;
const ONE = `query CustomerById($id: ID!) { customer(id: $id) { ${FIELDS} } }`;

export function saveCustomer(shop, customer, timeZone) {
  db.prepare(`INSERT INTO customers (id, shop, display_name, created_at, local_date, updated_at, number_of_orders, amount_spent, last_order_at, state)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=excluded.updated_at, number_of_orders=excluded.number_of_orders,
      amount_spent=excluded.amount_spent, last_order_at=excluded.last_order_at, state=excluded.state`)
    .run(customer.id, shop, customer.displayName, customer.createdAt, localDate(customer.createdAt, timeZone), customer.updatedAt,
      Number(customer.numberOfOrders ?? 0), Number(customer.amountSpent?.amount ?? 0), customer.lastOrder?.processedAt || null, customer.state);
}

export async function syncCustomers(shop, { since, timeZone, onPage }) {
  let count = 0; let latest = since;
  const query = since ? `updated_at:>='${since}'` : null;
  for await (const nodes of paginate(shop, LIST, { query }, (data) => data.customers, { operation: 'syncCustomers', expectedCost: 300 })) {
    for (const customer of nodes) { saveCustomer(shop, customer, timeZone); if (!latest || customer.updatedAt > latest) latest = customer.updatedAt; }
    count += nodes.length; onPage?.(count);
  }
  return { count, latest };
}

export async function refreshCustomer(shop, id, timeZone) {
  const data = await graphql(shop, ONE, { id }, { operation: 'customerById' });
  if (!data.customer) { deleteCustomer(id); return null; }
  saveCustomer(shop, data.customer, timeZone);
  return data.customer;
}

// Used for deletions and GDPR customers/redact: removes stored personal data, keeps anonymous order totals.
export function deleteCustomer(id) {
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  db.prepare('UPDATE orders SET customer_name = NULL WHERE customer_id = ?').run(id);
}
