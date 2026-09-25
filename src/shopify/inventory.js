import { db, transaction } from '../database/db.js';
import { paginate } from './client.js';

const ITEMS = `query SyncInventory($after: String) {
  inventoryItems(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
    nodes { id tracked unitCost { amount } inventoryLevels(first: 10) { nodes { updatedAt location { id } quantities(names: ["available"]) { quantity } } } } } }`;

export function saveInventoryLevel(shop, { inventoryItemId, locationId, available, updatedAt }) {
  db.prepare(`INSERT INTO inventory_levels (inventory_item_id, location_id, shop, available, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(inventory_item_id, location_id) DO UPDATE SET available=excluded.available, updated_at=excluded.updated_at`)
    .run(inventoryItemId, locationId, shop, available, updatedAt);
}

export async function syncInventory(shop, { onPage } = {}) {
  let count = 0;
  for await (const nodes of paginate(shop, ITEMS, {}, (data) => data.inventoryItems, { operation: 'syncInventory', expectedCost: 600 })) {
    transaction(() => {
      const setCost = db.prepare("UPDATE variants SET unit_cost = ? WHERE inventory_item_id = ?");
      for (const item of nodes) {
        // Cost edits live on the inventory item, so this refresh also keeps variant costs current.
        setCost.run(item.unitCost?.amount == null ? null : Number(item.unitCost.amount), item.id);
        for (const level of item.inventoryLevels.nodes) {
          saveInventoryLevel(shop, { inventoryItemId: item.id, locationId: level.location.id, available: level.quantities[0]?.quantity ?? null, updatedAt: level.updatedAt });
        }
      }
    });
    count += nodes.length; onPage?.(count);
  }
  return { count };
}

export function deleteInventoryLevel(inventoryItemId, locationId) {
  db.prepare('DELETE FROM inventory_levels WHERE inventory_item_id = ? AND location_id = ?').run(inventoryItemId, locationId);
}
