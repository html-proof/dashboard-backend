import { randomBytes } from 'node:crypto';
import { config, shopDomain } from '../config.js';
import { db } from '../database/db.js';
import { safeEqual, verifyQueryHmac } from './crypto.js';
import { storeToken } from './token_service.js';
import { log } from '../logger.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE = 'shopify_oauth_state';

function cookie(request, name) {
  return (request.headers.cookie || '').split(/;\s*/).map((part) => part.split('=')).find(([key]) => key === name)?.[1] || null;
}

function stateCookie(value, maxAgeSeconds) {
  return `${COOKIE}=${value}; Path=/shopify/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${config.appUrl.startsWith('https://') ? '; Secure' : ''}`;
}

export class OAuthError extends Error {
  constructor(message, category) { super(message); this.category = category; }
}

// Step 1: send the merchant to Shopify's consent screen.
export function beginAuth(url) {
  const shop = shopDomain(url.searchParams.get('shop')) || config.shopify.store;
  if (!shop) throw new OAuthError('Provide a valid ?shop=<store>.myshopify.com domain.', 'invalid_store');
  if (!config.shopify.clientId || !config.shopify.clientSecret) throw new OAuthError('Shopify app credentials are not configured on the server.', 'not_configured');

  db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(Date.now() - STATE_TTL_MS);
  const state = randomBytes(24).toString('hex');
  db.prepare('INSERT INTO oauth_states (state, shop, created_at) VALUES (?, ?, ?)').run(state, shop, Date.now());

  const redirect = new URL(`https://${shop}/admin/oauth/authorize`);
  redirect.searchParams.set('client_id', config.shopify.clientId);
  redirect.searchParams.set('scope', config.shopify.scopes);
  redirect.searchParams.set('redirect_uri', `${config.appUrl}/shopify/auth/callback`);
  redirect.searchParams.set('state', state);
  // Offline (non-expiring) token: omit grant_options[]=per-user.
  return { location: redirect.toString(), setCookie: stateCookie(state, STATE_TTL_MS / 1000), shop };
}

// Step 2: validate everything Shopify sends back, then exchange the one-time code.
export async function completeAuth(url, request) {
  const params = url.searchParams;
  const shop = shopDomain(params.get('shop'));
  const state = params.get('state');
  const code = params.get('code');
  if (!shop) throw new OAuthError('Invalid shop in callback.', 'invalid_store');
  if (!verifyQueryHmac(params)) throw new OAuthError('Shopify callback HMAC is invalid.', 'invalid_hmac');
  const timestamp = Number(params.get('timestamp'));
  if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 600) throw new OAuthError('Shopify callback is too old.', 'invalid_hmac');

  const stored = state && db.prepare('SELECT shop, created_at FROM oauth_states WHERE state = ?').get(state);
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state || '');
  if (!stored || stored.shop !== shop || Date.now() - stored.created_at > STATE_TTL_MS || !safeEqual(cookie(request, COOKIE), state)) {
    throw new OAuthError('OAuth state is invalid or expired. Start again from /shopify/auth.', 'invalid_state');
  }
  if (!code) throw new OAuthError('Authorization code missing.', 'invalid_state');

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, code }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new OAuthError('Shopify rejected the authorization code exchange.', 'token_exchange_failed');

  const granted = String(payload.scope || '').split(',').filter(Boolean);
  const missing = config.shopify.scopes.split(',').filter((scope) => !granted.includes(scope) && !granted.includes(scope.replace('read_', 'write_')));
  storeToken(shop, { token: payload.access_token, scope: payload.scope, grantType: 'authorization_code' });
  log.info('shopify.oauth.completed', { shop, grantedScopes: granted.length, missingScopes: missing });
  return { shop, missingScopes: missing, clearCookie: stateCookie('', 0) };
}
