import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getAccessToken, invalidateToken } from '../auth/token_service.js';
import { log } from '../logger.js';

export class ShopifyError extends Error {
  constructor(message, { category = 'shopify_error', status = null, details = null } = {}) {
    super(message); this.category = category; this.status = status; this.details = details;
  }
}

const MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

// Leaky-bucket awareness: remember the last throttle status per shop and wait before we'd exceed it.
const throttle = new Map();

async function waitForBudget(shop, cost = 100) {
  const status = throttle.get(shop);
  if (!status) return;
  const elapsed = (Date.now() - status.at) / 1000;
  const available = Math.min(status.maximumAvailable, status.currentlyAvailable + elapsed * status.restoreRate);
  if (available < cost) await sleep(Math.ceil(((cost - available) / status.restoreRate) * 1000));
}

export async function graphql(shop, query, variables = {}, { operation = 'query', expectedCost = 100 } = {}) {
  const requestId = randomUUID();
  let refreshedToken = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await waitForBudget(shop, expectedCost);
    const token = await getAccessToken(shop);
    const started = Date.now();
    let response;
    try {
      response = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(config.requestTimeoutMs)
      });
    } catch (error) {
      log.warn('shopify.request.network_error', { requestId, shop, operation, attempt, error: error.name });
      if (attempt === MAX_ATTEMPTS - 1) throw new ShopifyError('Shopify could not be reached.', { category: 'network' });
      await sleep(backoff(attempt)); continue;
    }

    const payload = await response.json().catch(() => null);
    const cost = payload?.extensions?.cost;
    if (cost?.throttleStatus) throttle.set(shop, { ...cost.throttleStatus, at: Date.now() });
    log.info('shopify.request', { requestId, shop, endpoint: 'graphql', operation, status: response.status, ms: Date.now() - started, cost: cost ? { requested: cost.requestedQueryCost, actual: cost.actualQueryCost, available: cost.throttleStatus?.currentlyAvailable } : undefined });

    if (response.status === 401) {
      invalidateToken(shop);
      if (!refreshedToken) { refreshedToken = true; continue; }
      throw new ShopifyError('Shopify rejected the access token (expired or revoked). Reconnect the store.', { category: 'unauthorized', status: 401 });
    }
    if (response.status === 403) throw new ShopifyError('The Shopify app lacks permission for this data.', { category: 'permission_denied', status: 403 });
    if (response.status === 404) throw new ShopifyError('Shopify store or API version not found.', { category: 'invalid_store', status: 404 });
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      if (attempt === MAX_ATTEMPTS - 1) throw new ShopifyError(`Shopify responded ${response.status} after retries.`, { category: response.status === 429 ? 'rate_limited' : 'upstream', status: response.status });
      await sleep(retryAfter || backoff(attempt)); continue;
    }
    if (!payload) throw new ShopifyError('Shopify returned an unreadable response.', { category: 'upstream', status: response.status });

    if (payload.errors?.length) {
      const codes = payload.errors.map((error) => error.extensions?.code);
      if (codes.includes('THROTTLED')) {
        const { requestedQueryCost = expectedCost } = cost || {};
        const status = cost?.throttleStatus;
        await sleep(status ? Math.ceil(((requestedQueryCost - status.currentlyAvailable) / status.restoreRate) * 1000) + 250 : backoff(attempt));
        continue;
      }
      const message = payload.errors.map((error) => error.message).join('; ');
      const denied = codes.includes('ACCESS_DENIED') || /access denied|required access/i.test(message);
      throw new ShopifyError(denied ? `Missing Shopify permission: ${message}` : `Shopify GraphQL error: ${message}`, { category: denied ? 'missing_scope' : 'graphql_error', details: codes });
    }
    return payload.data;
  }
  throw new ShopifyError('Shopify request failed after retries.', { category: 'rate_limited' });
}

// Mutations report business-rule failures in userErrors rather than errors.
export function assertNoUserErrors(result, label) {
  const errors = result?.userErrors || [];
  if (errors.length) throw new ShopifyError(`${label}: ${errors.map((error) => error.message).join('; ')}`, { category: 'user_errors', details: errors });
  return result;
}

// Cursor pagination: follows pageInfo.endCursor until Shopify reports no next page.
export async function* paginate(shop, query, variables, select, options) {
  let after = null;
  do {
    const data = await graphql(shop, query, { ...variables, after }, options);
    const connection = select(data);
    yield connection.nodes;
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);
}
