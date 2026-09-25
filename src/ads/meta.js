import { db } from '../database/db.js';
import { config } from '../config.js';
import { addDays } from '../dashboard/dates.js';
import { saveApiAdSpend } from '../dashboard/profit.js';
import { integrationCredentials, recordSync } from '../integrations/index.js';
import { log } from '../logger.js';

// Meta (Facebook & Instagram) ad spend via the Marketing API Insights endpoint. Server-side only.
// Each store uses the ad account and token saved on its Integrations page. The META_AD_ACCOUNT_ID /
// META_ACCESS_TOKEN env vars remain as a fallback for the SHOPIFY_STORE configured on the server.
const env = process.env;
const version = () => env.META_API_VERSION || 'v23.0';

function credentials(shop) {
  const saved = integrationCredentials(shop, 'meta');
  if (saved) return saved.token ? { accountId: saved.accountId.replace(/^act_/, ''), token: saved.token, saved: true } : null;
  if (shop === config.shopify.store && env.META_AD_ACCOUNT_ID && env.META_ACCESS_TOKEN) return { accountId: String(env.META_AD_ACCOUNT_ID).replace(/^act_/, ''), token: env.META_ACCESS_TOKEN, saved: false };
  return null;
}
export const metaConfigured = (shop) => Boolean(credentials(shop));

async function graph(url, token) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;
    const code = body.error?.code;
    // 4/17/32/613 = Meta rate limiting; back off and retry.
    if ([4, 17, 32, 613].includes(code) || response.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
    throw Object.assign(new Error(`Meta API: ${body.error?.message || response.status}`), { category: response.status === 401 || code === 190 ? 'unauthorized' : 'upstream' });
  }
  throw Object.assign(new Error('Meta API rate limited'), { category: 'rate_limited' });
}

const statuses = new Map(); // shop -> { lastSyncAt, error, currency }
export const metaStatus = (shop) => ({ configured: metaConfigured(shop), lastSyncAt: null, error: null, currency: null, ...statuses.get(shop) });

export async function syncMetaSpend(shop, { today }) {
  const creds = credentials(shop);
  if (!creds) return null;
  const status = { ...statuses.get(shop) };
  try {
    const account = await graph(`https://graph.facebook.com/${version()}/act_${creds.accountId}?fields=currency,name`, creds.token);
    status.currency = account.currency;
    // First run backfills from the first order (Meta keeps ~37 months); later runs refresh the last 7 days,
    // because Meta can restate recent spend.
    const hasData = db.prepare("SELECT 1 FROM ad_spend WHERE shop = ? AND platform = 'meta' AND source = 'api' LIMIT 1").get(shop);
    const firstOrder = db.prepare('SELECT MIN(local_date) AS d FROM orders WHERE shop = ?').get(shop)?.d;
    const floor = addDays(today, -365 * 3);
    const since = hasData ? addDays(today, -7) : (firstOrder && firstOrder > floor ? firstOrder : floor);
    const params = new URLSearchParams({ fields: 'spend', level: 'account', time_increment: '1', limit: '500', time_range: JSON.stringify({ since, until: today }) });
    let url = `https://graph.facebook.com/${version()}/act_${creds.accountId}/insights?${params}`;
    const rows = [];
    while (url) {
      const page = await graph(url, creds.token);
      for (const row of page.data || []) rows.push({ date: row.date_start, amount: Number(row.spend) || 0 });
      url = page.paging?.next || null;
    }
    saveApiAdSpend(shop, 'meta', rows, account.currency);
    status.lastSyncAt = new Date().toISOString(); status.error = null;
    if (creds.saved) recordSync(shop, 'meta', { accountName: account.name });
    log.info('ads.meta.synced', { shop, days: rows.length, since });
    return rows.length;
  } catch (error) {
    status.error = error.message;
    if (creds.saved) recordSync(shop, 'meta', { error: error.message });
    log.error('ads.meta.failed', { shop, category: error.category, error: error.message });
    return null;
  } finally { statuses.set(shop, status); }
}
