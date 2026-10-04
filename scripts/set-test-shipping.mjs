#!/usr/bin/env node
// Put a TEST order back on a given shipping service, in Shopify and Order Desk,
// so the customer flow can be tried again.
//
//   node scripts/set-test-shipping.mjs S64262 --to "FedEx Ground" --price 15.70 [--env dev]
//
// Shopify: order edit — the current shipping line replaced by `--to` at
//          `--price` (if it is not already that). Moving to a cheaper service
//          leaves the order overpaid; the script prints the amount, and the
//          refund is issued by hand in Shopify admin (Refund → store credit).
// Order Desk: shipping_method, shipping_total and order_total set to match,
//          with a note.
// Records: the pending change record is deleted and the page row re-seeded.
//
// Writes for the named order only (WRITE_ONLY_ORDERS). Credentials from SSM.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ORDER = String(process.argv[2] ?? '').trim().replace(/^#/, '').toUpperCase();
const TO = arg('to');
const PRICE = arg('price');
if (!/^S\d+$/.test(ORDER) || !TO || !/^\d+(\.\d{1,2})?$/.test(PRICE ?? '')) {
  console.error('usage: scripts/set-test-shipping.mjs <S-number> --to "FedEx Ground" --price 15.70 [--env dev]');
  process.exit(1);
}
process.env.SB_ENV = arg('env', 'dev');
process.env.SHOPIFY_WRITES = 'enabled';
process.env.WRITE_ONLY_ORDERS = ORDER;

const { getSecret } = await import('../src/shared/secrets.mjs');
const { makeShopifyCredentials } = await import('../src/shared/shopify-auth.mjs');
const { fetchOrderForPricing } = await import('../src/shared/shopify-pricing.mjs');
const { stageShippingChange, commitShippingChange } = await import('../src/shared/shopify-order-edit.mjs');
const { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } = await import('../src/shared/orderdesk-fetch.mjs');
const { toCents, centsToAmount } = await import('../src/shared/money.mjs');

const priceCents = toCents(PRICE);
const TABLE = `sb-${process.env.SB_ENV}-jobs`;

// ── Shopify ──────────────────────────────────────────────────────────────
const creds = await makeShopifyCredentials({ getSecret })();
const order = await fetchOrderForPricing({ ...creds, orderName: ORDER });
if (!order) throw new Error('Shopify order not found');
if (order.shippingLines.length !== 1) throw new Error(`expected one shipping line: ${JSON.stringify(order.shippingLines)}`);
const line = order.shippingLines[0];
if (line.title === TO && line.originalCents === priceCents) {
  console.log(`Shopify: already ${TO} $${PRICE}`);
} else {
  const staged = await stageShippingChange({ ...creds, orderId: order.id, removeLineId: line.id, title: TO, priceCents });
  if (!staged.ok) throw new Error(`stage failed: ${staged.reason}`);
  const done = await commitShippingChange({ ...creds, orderName: ORDER, calculatedOrderId: staged.calculatedOrderId,
    staffNote: `TEST reset: shipping set to ${TO} $${PRICE}` });
  if (!done.committed) throw new Error(`commit failed: ${JSON.stringify(done)}`);
  console.log(`Shopify: ${line.title} → ${TO} $${PRICE}; total $${centsToAmount(done.totalCents)}, outstanding $${centsToAmount(done.outstandingCents)}`);
}
const after = await fetchOrderForPricing({ ...creds, orderName: ORDER });
const overpaid = await (async () => {
  const r = await fetch(`https://${creds.shop}/admin/api/2025-07/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': creds.token },
    body: JSON.stringify({ query: `{ order(id: "${after.id}") { netPaymentSet { shopMoney { amount } } currentTotalPriceSet { shopMoney { amount } } } }` }),
  });
  const o = (await r.json())?.data?.order;
  return toCents(o?.netPaymentSet?.shopMoney?.amount) - toCents(o?.currentTotalPriceSet?.shopMoney?.amount);
})();

// ── Order Desk ───────────────────────────────────────────────────────────
const [storeId, apiKey] = await Promise.all([getSecret('orderdesk', 'store-id'), getSecret('orderdesk', 'api-key')]);
const hdr = (x) => orderDeskHeaders(storeId, apiKey, x);
const found = ((await (await orderDeskFetch(`${ORDERDESK_API}/orders?source_id=${ORDER}`, { headers: hdr() })).json())?.orders ?? [])
  .filter((o) => o.source_id === ORDER);
if (found.length !== 1) throw new Error(`expected one Order Desk order ${ORDER}, found ${found.length}`);
const od = (await (await orderDeskFetch(`${ORDERDESK_API}/orders/${found[0].id}`, { headers: hdr() })).json()).order;
const shipDelta = priceCents - toCents(String(od.shipping_total ?? 0));
const updated = {
  ...od,
  shipping_method: TO,
  shipping_total: centsToAmount(priceCents),
  order_total: centsToAmount(toCents(String(od.order_total)) + shipDelta),
  order_notes: [...(od.order_notes ?? []), { username: 'SBBot', content: `TEST reset: shipping set to ${TO} $${PRICE}` }],
};
const put = await orderDeskFetch(`${ORDERDESK_API}/orders/${od.id}`, { method: 'PUT', headers: hdr({ 'Content-Type': 'application/json' }), body: JSON.stringify(updated) });
if (!put.ok) throw new Error(`Order Desk PUT ${put.status}: ${(await put.text()).slice(0, 200)}`);
console.log(`Order Desk: ${od.shipping_method} → ${TO}, shipping $${updated.shipping_total}, total $${updated.order_total}`);

// ── records ──────────────────────────────────────────────────────────────
execFileSync('aws', ['dynamodb', 'delete-item', '--table-name', TABLE,
  '--key', JSON.stringify({ PK: { S: `ORDER#${ORDER}` }, SK: { S: 'CHANGE' } })]);
console.log('Change record cleared.');
const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(here, 'seed-test-row.mjs'), ORDER, '--env', process.env.SB_ENV], { stdio: 'inherit' });

if (overpaid > 0) {
  console.log(`\n⚠ Shopify now holds $${centsToAmount(overpaid)} more than the order total.`
    + ` Refund it by hand: Shopify admin → ${ORDER} → Refund → store credit.`);
}
