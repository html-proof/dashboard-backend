import { graphql } from './client.js';

// Shopify's own storefront session analytics via ShopifyQL (requires read_reports).
// These are Shopify-measured session counts, not order records, and are labelled as such.
const QUERY = `query Funnel($q: String!) { shopifyqlQuery(query: $q) { parseErrors tableData { columns { name dataType } rows } } }`;
const COLUMNS = 'sessions, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout';

async function run(shop, q) {
  const data = await graphql(shop, QUERY, { q }, { operation: 'shopifyql', expectedCost: 10 });
  const result = data.shopifyqlQuery;
  if (result.parseErrors?.length) throw Object.assign(new Error(result.parseErrors.join('; ')), { category: 'shopifyql_error' });
  return result.tableData?.rows || [];
}

const num = (value) => (value == null || value === '' ? null : Number(value));

// Shopify's own sales report, the figures the Shopify admin shows (tax-exclusive gross/net for
// tax-inclusive shops, returns net of refunded shipping/tax, total sales after returns).
const SALES = 'orders, gross_sales, discounts, returns, net_sales, taxes, shipping_charges, total_sales, average_order_value, net_items_sold';
const salesRow = (row) => row && ({
  orders: num(row.orders), grossSales: num(row.gross_sales), discounts: Math.abs(num(row.discounts) ?? 0), returns: Math.abs(num(row.returns) ?? 0),
  netSales: num(row.net_sales), taxes: num(row.taxes), shipping: num(row.shipping_charges), totalSales: num(row.total_sales),
  averageOrderValue: row.average_order_value == null ? null : Math.round(num(row.average_order_value) * 100) / 100, netItemsSold: num(row.net_items_sold)
});

export async function salesReport(shop, startDate, endDate) {
  const [row] = await run(shop, `FROM sales SHOW ${SALES} SINCE ${startDate} UNTIL ${endDate}`);
  return salesRow(row) || null;
}

export async function salesReportSeries(shop, { startDate, endDate, granularity }) {
  const rows = await run(shop, `FROM sales SHOW ${SALES} TIMESERIES ${granularity} SINCE ${startDate} UNTIL ${endDate}`);
  return rows.map((row) => ({ period: row[granularity], ...salesRow(row) }));
}

export async function sessionsSeries(shop, { startDate, endDate, granularity }) {
  const rows = await run(shop, `FROM sessions SHOW sessions, sessions_that_completed_checkout TIMESERIES ${granularity} SINCE ${startDate} UNTIL ${endDate}`);
  return rows.map((row) => ({ period: row[granularity], sessions: num(row.sessions), completed: num(row.sessions_that_completed_checkout) }));
}

export async function sessionFunnel(shop, { startDate, endDate }) {
  const [totals] = await run(shop, `FROM sessions SHOW ${COLUMNS} SINCE ${startDate} UNTIL ${endDate}`);
  const daily = await run(shop, `FROM sessions SHOW ${COLUMNS} TIMESERIES day SINCE ${startDate} UNTIL ${endDate}`);
  if (!totals) return null;
  return {
    steps: [
      { key: 'sessions', label: 'Sessions', value: num(totals.sessions) },
      { key: 'cart', label: 'Added to cart', value: num(totals.sessions_with_cart_additions) },
      { key: 'checkout', label: 'Reached checkout', value: num(totals.sessions_that_reached_checkout) },
      { key: 'completed', label: 'Completed checkout', value: num(totals.sessions_that_completed_checkout) }
    ],
    daily: daily.map((row) => ({ date: row.day, sessions: num(row.sessions), cart: num(row.sessions_with_cart_additions), checkout: num(row.sessions_that_reached_checkout), completed: num(row.sessions_that_completed_checkout) }))
  };
}
