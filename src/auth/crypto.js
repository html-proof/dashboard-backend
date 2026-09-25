import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function key() {
  if (!/^[0-9a-f]{64}$/i.test(config.tokenEncryptionKey)) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters.');
  return Buffer.from(config.tokenEncryptionKey, 'hex');
}

// AES-256-GCM: output is iv.tag.ciphertext (base64url), authenticated so tampering is detected.
export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');
}

export function decrypt(payload) {
  const [iv, tag, body] = String(payload).split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

// OAuth redirect / app-proxy query HMAC (hex digest over sorted params, excluding hmac & signature).
export function verifyQueryHmac(searchParams, secret = config.shopify.clientSecret) {
  const hmac = searchParams.get('hmac');
  if (!hmac || !secret) return false;
  const message = [...searchParams.entries()]
    .filter(([name]) => name !== 'hmac' && name !== 'signature')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  return safeEqual(hmac, createHmac('sha256', secret).update(message).digest('hex'));
}

// Webhook HMAC (base64 digest over the raw body bytes).
export function verifyWebhookHmac(rawBody, header, secret = config.shopify.clientSecret) {
  if (!header || !secret) return false;
  return safeEqual(header, createHmac('sha256', secret).update(rawBody).digest('base64'));
}
