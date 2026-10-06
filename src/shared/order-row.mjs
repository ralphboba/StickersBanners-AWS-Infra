// The order row the customer's "Manage my order" page works from — wherever
// the order sits in Order Desk.
//
// Normally it is the jobs-table row the mirror keeps (folder, items, shipping,
// and the Shopify order-status URL that authorises the page). But the mirror
// only reads some folders, refreshes once a minute, and a row the pipeline
// claimed may have no link yet. None of that is the customer's problem: when
// the stored row cannot authorise the request, the order is read live —
// Shopify first (its order-status URL is the access check), and Order Desk
// only once the presented token matches, so a request without the right link
// never reaches Order Desk.

import { parseOrderStatusUrl, authorisesOrder } from './order-token.mjs';
import { fetchOrderByName } from './shopify-orders.mjs';
import { cleanOrder } from './orderdesk.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from './orderdesk-fetch.mjs';

/** Real orders can carry undefined/NaN fields; drop them, as the mirror does. */
function sanitize(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) { const x = sanitize(v[k]); if (x !== undefined) o[k] = x; }
    return o;
  }
  return v;
}

/** The one Order Desk order whose source_id is this name, or null. */
export async function fetchOrderDeskOrder({ getSecret, orderName, fetchImpl }) {
  const [storeId, apiKey] = await Promise.all([getSecret('orderdesk', 'store-id'), getSecret('orderdesk', 'api-key')]);
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders?source_id=${encodeURIComponent(orderName)}`,
    { headers: orderDeskHeaders(storeId, apiKey) },
    // A customer is waiting: one short retry on a rate limit, never a long wait.
    { maxAttempts: 2, budgetMs: 8_000, ...(fetchImpl ? { fetchImpl } : {}) });
  if (!res.ok) throw new Error(`Order Desk search ${res.status}`);
  const found = ((await res.json())?.orders ?? []).filter((o) => o.source_id === orderName);
  return found.length === 1 ? found[0] : null;
}

/**
 * @param {{ readRow: (name: string) => Promise<object|undefined>,
 *           shopifyCreds: () => Promise<{shop: string, token: string}>,
 *           getSecret: Function,
 *           fetchShopify?: Function, fetchOrderDesk?: Function }} deps
 * @returns {(orderName: string, presentedUrl?: string) => Promise<object|undefined>}
 */
export function makeOrderRowLoader({
  readRow, shopifyCreds, getSecret,
  fetchShopify = fetchOrderByName, fetchOrderDesk = fetchOrderDeskOrder,
}) {
  return async function loadRow(orderName, presentedUrl) {
    const row = await readRow(orderName);
    // A mirror row is refreshed every minute and removed when the order leaves
    // the mirrored folders, so its folder and link can be trusted. A row the
    // pipeline claimed is not kept current that way: its folder may be hours
    // old (and then the page could offer a change on an order already past
    // production), so it is always read live.
    if (row?.mirror === true && row.orderStatusUrl && row.folderId) return row;
    // A request that isn't even shaped like an order-status link costs nothing.
    if (!parseOrderStatusUrl(presentedUrl)) return row;

    let statusPageUrl;
    try {
      statusPageUrl = (await fetchShopify({ ...(await shopifyCreds()), orderName }))?.statusPageUrl;
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'live order read: Shopify failed', orderName, err: String(err) }));
      return row;
    }
    if (!statusPageUrl || !authorisesOrder(presentedUrl, statusPageUrl)) return row;

    let od;
    try {
      od = await fetchOrderDesk({ getSecret, orderName });
    } catch (err) {
      console.warn(JSON.stringify({ msg: 'live order read: Order Desk failed', orderName, err: String(err) }));
      return row;
    }
    if (!od) return row;

    console.log(JSON.stringify({ msg: 'order read live', orderName, folderId: String(od.folder_id), hadRow: Boolean(row) }));
    return {
      // Order Desk now wins over whatever the stored row last saw (a paid
      // shipping change, a moved folder); the row adds only what OD lacks.
      ...(row ?? {}),
      ...sanitize(cleanOrder(od)),
      // The folder right now, and the link Shopify just confirmed.
      folderId: String(od.folder_id),
      orderStatusUrl: statusPageUrl,
    };
  };
}
