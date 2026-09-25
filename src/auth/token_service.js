import { config } from '../config.js';
import { db } from '../database/db.js';
import { decrypt, encrypt } from './crypto.js';
import { log } from '../logger.js';

export class AuthError extends Error {
  constructor(message, category = 'unauthorized') { super(message); this.category = category; }
}

const memory = new Map(); // decrypted-token cache, process memory only

export function storeToken(shop, { token, scope, grantType, expiresInSeconds }) {
  const expiresAt = expiresInSeconds ? Date.now() + Math.max(expiresInSeconds - 120, 60) * 1000 : null;
  db.prepare(`INSERT INTO access_tokens (shop, token_enc, scope, grant_type, expires_at, created_at, revoked)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(shop) DO UPDATE SET token_enc = excluded.token_enc, scope = excluded.scope, grant_type = excluded.grant_type,
      expires_at = excluded.expires_at, created_at = excluded.created_at, revoked = 0`)
    .run(shop, encrypt(token), scope || null, grantType, expiresAt, new Date().toISOString());
  memory.set(shop, { token, expiresAt });
}

export function revokeToken(shop, reason) {
  db.prepare('UPDATE access_tokens SET revoked = 1 WHERE shop = ?').run(shop);
  memory.delete(shop);
  log.warn('shopify.token.revoked', { shop, reason });
}

export function tokenStatus(shop) {
  const row = db.prepare('SELECT scope, grant_type, expires_at, created_at, revoked FROM access_tokens WHERE shop = ?').get(shop);
  if (!row) return { stored: false };
  return { stored: true, grantType: row.grant_type, revoked: Boolean(row.revoked), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, scopes: row.scope ? row.scope.split(',') : [] };
}

// Shopify's client-credentials grant: valid only for apps owned by the same organisation as the store.
async function clientCredentialsToken(shop) {
  const { clientId, clientSecret } = config.shopify;
  if (!clientId || !clientSecret) return null;
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    log.warn('shopify.token.client_credentials_failed', { shop, status: response.status, error: payload.error });
    return null;
  }
  storeToken(shop, { token: payload.access_token, scope: payload.scope, grantType: 'client_credentials', expiresInSeconds: Number(payload.expires_in) || 86_400 });
  log.info('shopify.token.issued', { shop, grantType: 'client_credentials' });
  return payload.access_token;
}

export async function getAccessToken(shop) {
  if (!shop) throw new AuthError('No Shopify store is configured. Set SHOPIFY_STORE or connect through /shopify/auth.', 'invalid_store');
  const cached = memory.get(shop);
  if (cached && (!cached.expiresAt || cached.expiresAt > Date.now())) return cached.token;

  const row = db.prepare('SELECT token_enc, grant_type, expires_at, revoked FROM access_tokens WHERE shop = ?').get(shop);
  if (row && !row.revoked && (!row.expires_at || row.expires_at > Date.now())) {
    const token = decrypt(row.token_enc);
    memory.set(shop, { token, expiresAt: row.expires_at });
    return token;
  }
  // An offline OAuth token that was revoked must be re-authorised by a person; never silently swap credentials.
  if (row?.revoked && row.grant_type === 'authorization_code') throw new AuthError('Shopify authorization was revoked. Reconnect the store at /shopify/auth.', 'revoked');

  if (config.shopify.staticAccessToken && shop === config.shopify.store) return config.shopify.staticAccessToken;
  const issued = await clientCredentialsToken(shop);
  if (issued) return issued;
  throw new AuthError('No valid Shopify Admin access token. Connect the store at /shopify/auth.', 'not_connected');
}

// Forces a fresh token on the next call (used after a 401 on an expiring token).
export function invalidateToken(shop) {
  memory.delete(shop);
  const row = db.prepare('SELECT grant_type FROM access_tokens WHERE shop = ?').get(shop);
  if (row?.grant_type === 'client_credentials') db.prepare('DELETE FROM access_tokens WHERE shop = ?').run(shop);
  else if (row) revokeToken(shop, 'Shopify returned 401');
}
