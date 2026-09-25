import { createHmac } from 'node:crypto';
import { config, shopDomain } from '../config.js';
import { db } from '../database/db.js';
import { safeEqual } from './crypto.js';

// Signed, HttpOnly session cookie naming the store the browser signed in as (via Shopify OAuth).
// Each merchant therefore only ever sees their own store's data. Payload: shop.expiry.signature.
const COOKIE = 'kyn_session';
const TTL_SECONDS = 30 * 24 * 3600;

const sign = (value) => createHmac('sha256', config.tokenEncryptionKey || config.shopify.clientSecret).update(`session:${value}`).digest('base64url');
const secure = () => (config.appUrl.startsWith('https://') ? '; Secure' : '');

export function sessionCookie(shop) {
  const value = `${shop}.${Math.floor(Date.now() / 1000) + TTL_SECONDS}`;
  return `${COOKIE}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_SECONDS}${secure()}`;
}

export const clearSessionCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure()}`;

export function sessionShop(request) {
  const raw = (request.headers.cookie || '').split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const match = raw?.match(/^(.+)\.(\d+)\.([A-Za-z0-9_-]+)$/);
  if (!match || !safeEqual(match[3], sign(`${match[1]}.${match[2]}`)) || Number(match[2]) * 1000 < Date.now()) return null;
  const shop = shopDomain(match[1]);
  // A session is only valid while the store still has a live (non-revoked) token.
  const token = shop && db.prepare('SELECT revoked FROM access_tokens WHERE shop = ?').get(shop);
  return token && !token.revoked ? shop : null;
}

// Every store with a live token: these are the tenants the scheduler keeps in sync.
export function connectedShops() {
  const shops = db.prepare('SELECT shop FROM access_tokens WHERE revoked = 0').all().map((r) => r.shop);
  if (config.shopify.store && !shops.includes(config.shopify.store)) shops.push(config.shopify.store);
  return shops;
}
