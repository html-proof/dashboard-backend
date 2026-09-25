// In-process TTL cache for computed dashboard responses. Cleared whenever a sync or webhook changes data.
// Swap for Redis when running more than one backend instance.
const entries = new Map();
const TTL_MS = 60_000;

export const cache = {
  async wrap(shop, key, compute) {
    const id = `${shop}|${key}`;
    const hit = entries.get(id);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const value = await compute();
    entries.set(id, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  },
  clear(shop) {
    for (const id of entries.keys()) if (id.startsWith(`${shop}|`)) entries.delete(id);
  }
};
