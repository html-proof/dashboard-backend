# Shopify analytics backend + dashboard

Server-side Shopify integration that syncs live Admin API data into a local database and serves an internal analytics dashboard. No static or demo numbers: every figure comes from Shopify. When a metric has no data, the UI shows **No data available**.

```
Shopify Admin GraphQL ──► sync (full, then incremental by updated_at) ──► SQLite ──► TTL cache ──► /api/dashboard/* ──► dashboard
        ▲                                                          ▲
   OAuth / token exchange                           verified, idempotent webhooks
```

## Run

Requires Node 22.13+ (uses the built-in `node:sqlite`). The project has no npm dependencies.

```bash
cp .env.example .env      # fill in the values; never commit .env
npm start                 # http://localhost:3000
npm test                  # offline security + logic tests (Shopify is mocked)
npm run test:live         # checks the real Shopify connection
npm run report            # PASS/FAIL report against the running server + real Shopify
```

## Authentication

The client secret stays on the server. It is never used as an API credential directly:

- **OAuth (any store):** open `/shopify/auth?shop=<store>.myshopify.com`. The server stores a one-time `state` (in the DB and in an HttpOnly cookie), and Shopify redirects to `/shopify/auth/callback`. The server checks the HMAC, the timestamp, the state and the cookie, then exchanges the code for an offline Admin token.
- **Client credentials (the app belongs to the same organisation as the store):** the server exchanges the client ID and secret for a 24-hour Admin token, and renews it automatically. PixMagic currently connects this way.

Tokens are encrypted with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) before they are stored. They are never logged or returned by any endpoint. When Shopify returns a 401, the server marks an OAuth token as revoked, and someone must reconnect the store. It does not quietly fall back to other credentials. The `app/uninstalled` webhook also revokes the token.

## Layout

```
src/
  auth/       shopify_oauth.js, token_service.js, crypto.js (AES-GCM, OAuth + webhook HMAC)
  shopify/    client.js (timeouts, retries, backoff, cost-aware throttling, cursor pagination)
              store.js, orders.js (incl. refunds + fulfillment), customers.js, products.js, inventory.js,
              analytics.js (ShopifyQL sessions funnel), webhooks.js, sync.js
  dashboard/  dates.js (presets, granularity, comparisons), metrics.js, tracking.js
  database/   db.js (schema)
  app.js      routes, rate limits, security headers      main.js  boot + sync scheduler
public/       dashboard (vanilla JS, same-origin only)
pixel/        web-pixel.js — Shopify Custom Pixel for first-party funnel events
legacy/       previous storefront-catalogue app (not used)
```

## API

All `/api/*` routes need `Authorization: Bearer $DASHBOARD_API_KEY` when that variable is set, and production requires it.

| Endpoint | Content |
|---|---|
| `GET /api/dashboard/overview` | Cards, fixed periods (today, yesterday, 7 days, month, year), trends, breakdowns, tables |
| `GET /api/dashboard/sales` | Gross, discounts, refunds, net, tax, shipping, total, AOV, units, trend, by product, by channel, by location |
| `GET /api/dashboard/orders` | Paged orders with line items. `status=all\|cancelled\|refunded\|unfulfilled\|pending`, `limit`, `offset` |
| `GET /api/dashboard/customers` | New and returning customers, top customers, lifetime values |
| `GET /api/dashboard/products` | Products with variants, price range, inventory, units sold and revenue in the range. `q` searches |
| `GET /api/dashboard/inventory` | Levels by location, low stock and out of stock. `threshold` sets the low-stock level |
| `GET /api/dashboard/refunds` | Refund totals, trend and list |
| `GET /api/dashboard/fulfillment` | Payment and fulfillment status breakdowns, and unfulfilled orders |
| `GET /api/dashboard/funnel` | Shopify sessions funnel, Admin orders and custom tracking, each reported separately |
| `GET /api/status` / `POST /api/sync?full=1` | Connection, token metadata and sync state / start a sync |

Date parameters: `preset=today|yesterday|last_7_days|last_30_days|last_90_days|this_week|this_month|last_month|this_quarter|last_quarter|this_year|last_year|custom`, or `start_date` and `end_date` (YYYY-MM-DD). `granularity=day|week|month|quarter|year` and `compare=previous_period|previous_year` are optional. Dates are in the **shop's timezone**.

Metric definitions are returned in `definitions`. Test orders are excluded. Cancelled orders are left out of sales and reported separately. Every response includes `dataQuality`. If the first sync has not finished, the response says so and the data is not presented as complete.

## Webhooks

Shopify delivers webhooks only to a public HTTPS `APP_URL`. When the app starts, it registers these topics: orders (create, updated, cancelled, paid, fulfilled), refunds, fulfillments, customers, products, inventory levels and app/uninstalled. Each delivery is checked against `X-Shopify-Hmac-Sha256`, de-duplicated by `X-Shopify-Event-Id`, and acknowledged before processing. The handler then fetches the changed resource again through GraphQL.

Configure the mandatory privacy topics (`customers/data_request`, `customers/redact`, `shop/redact`) in the app's Dev Dashboard configuration and point them at `/shopify/webhooks`. On localhost, the scheduled incremental sync (`SYNC_INTERVAL_MINUTES`) keeps data current instead.

## Funnel data

| Step | Source |
|---|---|
| Sessions, add to cart, reached checkout, completed checkout | Shopify Analytics through ShopifyQL (`read_reports`) |
| Purchases | Admin API orders |
| Product views, payment attempts, visitors per step | **Custom tracking only.** Install `pixel/web-pixel.js` as a Custom Pixel |
| Clicks, scroll, mouse movement, session duration | Not collected |

## Production notes

- Set `NODE_ENV=production`, an HTTPS `APP_URL` and `DASHBOARD_API_KEY`. The server refuses to start without them.
- The schema is plain SQL. To use PostgreSQL, swap `database/db.js` for a `pg` pool. To run more than one instance, swap `cache.js` for Redis.
- If `SHOPIFY_CLIENT_SECRET` or an Admin token is ever committed or shared, rotate it in the Shopify Dev Dashboard before using the app again.
