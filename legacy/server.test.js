import test from 'node:test';
import assert from 'node:assert/strict';

test('environment template defines credential slots without secret values', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('.env.example', 'utf8'));
  assert.doesNotMatch(source, /=(?:shpss_|shpat_|ghp_)/);
  assert.match(source, /^SHOPIFY_CLIENT_SECRET=$/m);
  assert.match(source, /SHOPIFY_STOREFRONT_DOMAIN/);
});
