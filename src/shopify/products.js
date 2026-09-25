import { db, transaction } from '../database/db.js';
import { graphql, paginate } from './client.js';

const PRODUCT_FIELDS = 'id title handle vendor productType status createdAt updatedAt totalInventory';
const VARIANT_FIELDS = 'id title sku price updatedAt inventoryQuantity product { id } inventoryItem { id tracked unitCost { amount } }';
const PRODUCTS = `query SyncProducts($after: String, $query: String) {
  products(first: 100, after: $after, sortKey: UPDATED_AT, query: $query) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`;
const VARIANTS = `query SyncVariants($after: String, $query: String) {
  productVariants(first: 200, after: $after, query: $query) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } } }`;
const ONE = `query ProductById($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS}
  variants(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } } } }`;

export function saveProduct(shop, p) {
  db.prepare(`INSERT INTO products (id, shop, title, handle, vendor, product_type, status, created_at, updated_at, total_inventory)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, handle=excluded.handle, vendor=excluded.vendor,
    product_type=excluded.product_type, status=excluded.status, updated_at=excluded.updated_at, total_inventory=excluded.total_inventory`)
    .run(p.id, shop, p.title, p.handle, p.vendor || null, p.productType || null, p.status, p.createdAt, p.updatedAt, p.totalInventory ?? null);
}

export function saveVariant(shop, v) {
  db.prepare(`INSERT INTO variants (id, shop, product_id, title, sku, price, inventory_item_id, inventory_quantity, tracked, updated_at, unit_cost)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id, title=excluded.title, sku=excluded.sku, unit_cost=excluded.unit_cost,
    price=excluded.price, inventory_item_id=excluded.inventory_item_id, inventory_quantity=excluded.inventory_quantity,
    tracked=excluded.tracked, updated_at=excluded.updated_at`)
    .run(v.id, shop, v.product?.id || null, v.title, v.sku || null, v.price == null ? null : Number(v.price), v.inventoryItem?.id || null,
      v.inventoryQuantity ?? null, v.inventoryItem?.tracked ? 1 : 0, v.updatedAt, v.inventoryItem?.unitCost?.amount == null ? null : Number(v.inventoryItem.unitCost.amount));
}

export async function syncProducts(shop, { since, onPage }) {
  let count = 0; let latest = since;
  const query = since ? `updated_at:>='${since}'` : null;
  for await (const nodes of paginate(shop, PRODUCTS, { query }, (data) => data.products, { operation: 'syncProducts', expectedCost: 120 })) {
    transaction(() => nodes.forEach((product) => saveProduct(shop, product)));
    for (const product of nodes) if (!latest || product.updatedAt > latest) latest = product.updatedAt;
    count += nodes.length; onPage?.(count);
  }
  return { count, latest };
}

export async function syncVariants(shop, { since, filter = null, onPage }) {
  let count = 0; let latest = since;
  const query = [filter, since && `updated_at:>='${since}'`].filter(Boolean).join(' ') || null;
  for await (const nodes of paginate(shop, VARIANTS, { query }, (data) => data.productVariants, { operation: 'syncVariants', expectedCost: 600 })) {
    transaction(() => nodes.forEach((variant) => saveVariant(shop, variant)));
    for (const variant of nodes) if (!latest || variant.updatedAt > latest) latest = variant.updatedAt;
    count += nodes.length; onPage?.(count);
  }
  return { count, latest };
}

export async function refreshProduct(shop, id) {
  const data = await graphql(shop, ONE, { id }, { operation: 'productById' });
  if (!data.product) { deleteProduct(id); return null; }
  const { variants, ...product } = data.product;
  transaction(() => {
    saveProduct(shop, product);
    variants.nodes.forEach((variant) => saveVariant(shop, variant));
  });
  if (variants.pageInfo.hasNextPage) await syncVariants(shop, { since: null, filter: `product_id:${id.split('/').pop()}` });
  return product;
}

export function deleteProduct(id) {
  transaction(() => {
    db.prepare('DELETE FROM variants WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
  });
}
