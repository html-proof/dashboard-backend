// Shopify Custom Pixel — paste into Shopify Admin → Settings → Customer events → Add custom pixel.
// Replace ENDPOINT with your backend's public HTTPS URL. This sends first-party funnel events that the
// Admin API does not expose (product views, payment attempts). It carries no secrets, and the data it
// produces is reported separately from Shopify order data because browsers can block or alter it.
const ENDPOINT = 'https://YOUR-BACKEND-DOMAIN/api/track';
const EVENTS = ['page_viewed', 'product_viewed', 'product_added_to_cart', 'checkout_started', 'payment_info_submitted', 'checkout_completed'];

for (const name of EVENTS) {
  analytics.subscribe(name, (event) => {
    const productId = event.data?.productVariant?.product?.id || event.data?.cartLine?.merchandise?.product?.id || null;
    fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: event.id, name: event.name, timestamp: event.timestamp, clientId: event.clientId, productId })
    }).catch(() => {});
  });
}
