import { db } from '../database/db.js';
import { decrypt, encrypt } from '../auth/crypto.js';
import { ValidationError } from '../dashboard/profit.js';

// Per-store connections to non-Shopify platforms. Every row belongs to one shop, so each merchant
// configures their own accounts. Credentials are AES-GCM encrypted and never returned by the API.
db.exec(`
CREATE TABLE IF NOT EXISTS integrations (
  shop TEXT NOT NULL, provider TEXT NOT NULL, account_id TEXT, account_name TEXT, credentials_enc TEXT,
  status TEXT NOT NULL DEFAULT 'saved', last_sync_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (shop, provider)
);`);

// `live` = the server can import data with the saved credentials today.
export const PROVIDERS = {
  deputy: { name: 'Deputy', description: 'Staff and approved timesheets', accountLabel: 'Deputy install URL', accountHint: 'e.g. yourbusiness.au.deputy.com', tokenLabel: 'Permanent access token', live: false,
    validate: (v) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.deputy\.com$/i.test(v) },
  meta: { name: 'Meta Ads', description: 'Facebook and Instagram ad spend', accountLabel: 'Ad account ID', accountHint: 'e.g. act_1234567890', tokenLabel: 'Access token (ads_read)', live: true,
    validate: (v) => /^(act_)?\d{5,20}$/.test(v) },
  google_ads: { name: 'Google Ads', description: 'Search, Shopping and campaign spend', accountLabel: 'Customer ID', accountHint: 'e.g. 123-456-7890', tokenLabel: null, live: false,
    validate: (v) => /^\d{3}-?\d{3}-?\d{4}$/.test(v) },
  google_analytics: { name: 'Google Analytics', description: 'Store sessions and conversion context', accountLabel: 'GA4 property ID', accountHint: 'e.g. 312345678', tokenLabel: null, live: false,
    validate: (v) => /^\d{6,12}$/.test(v) }
};

const row = (shop, provider) => db.prepare('SELECT * FROM integrations WHERE shop = ? AND provider = ?').get(shop, provider);

export function listIntegrations(shop) {
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const r = row(shop, id);
    const state = !r ? 'not_connected' : r.last_error ? 'error' : r.last_sync_at ? 'connected' : 'saved';
    return {
      id, name: p.name, description: p.description, accountLabel: p.accountLabel, accountHint: p.accountHint, tokenLabel: p.tokenLabel, liveImport: p.live,
      state, accountId: r?.account_id || null, accountName: r?.account_name || null, hasCredentials: Boolean(r?.credentials_enc),
      lastSyncAt: r?.last_sync_at || null, lastError: r?.last_error || null, updatedAt: r?.updated_at || null
    };
  });
}

export function saveIntegration(shop, provider, body) {
  const p = PROVIDERS[provider];
  if (!p) throw new ValidationError('Unknown integration.');
  const accountId = String(body?.accountId || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!p.validate(accountId)) throw new ValidationError(`${p.accountLabel} is not valid (${p.accountHint}).`);
  const token = typeof body?.accessToken === 'string' ? body.accessToken.trim() : '';
  if (token && (!p.tokenLabel || token.length > 4096)) throw new ValidationError('Access token is not accepted for this integration.');
  const existing = row(shop, provider);
  // A blank token keeps the stored one, so the ID can be edited without re-entering secrets.
  const credentials = token ? encrypt(token) : existing?.account_id === accountId ? existing.credentials_enc : null;
  db.prepare(`INSERT INTO integrations (shop, provider, account_id, account_name, credentials_enc, status, last_sync_at, last_error, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'saved', NULL, NULL, ?)
    ON CONFLICT(shop, provider) DO UPDATE SET account_id = excluded.account_id, account_name = NULL, credentials_enc = excluded.credentials_enc,
      status = 'saved', last_sync_at = NULL, last_error = NULL, updated_at = excluded.updated_at`)
    .run(shop, provider, accountId, credentials, new Date().toISOString());
  return listIntegrations(shop).find((i) => i.id === provider);
}

export function removeIntegration(shop, provider) {
  return db.prepare('DELETE FROM integrations WHERE shop = ? AND provider = ?').run(shop, provider).changes > 0;
}

// Server-side only: decrypted credentials for an import job.
export function integrationCredentials(shop, provider) {
  const r = row(shop, provider);
  return r ? { accountId: r.account_id, token: r.credentials_enc ? decrypt(r.credentials_enc) : null } : null;
}

export function recordSync(shop, provider, { error = null, accountName } = {}) {
  db.prepare(`UPDATE integrations SET last_error = ?, account_name = COALESCE(?, account_name)${error ? '' : ', last_sync_at = ?'} WHERE shop = ? AND provider = ?`)
    .run(...(error ? [error, accountName ?? null, shop, provider] : [null, accountName ?? null, new Date().toISOString(), shop, provider]));
}
