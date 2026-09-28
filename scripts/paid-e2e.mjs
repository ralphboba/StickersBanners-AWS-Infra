#!/usr/bin/env node
// Drive the real orders/paid handler (src/functions/shopify-paid/core.mjs) for
// one test order: a signed webhook, delivered twice, against the real Order
// Desk and Google Chat. The Order Desk record is snapshotted first to the same
// place scripts/upgrade-roundtrip.mjs restores from.
//
//   node scripts/paid-e2e.mjs <S-number> --orderdesk-id N --from "..." --to "..." \
//        --shipping-cents 3308 --tax-cents 0 --ref CHG-TEST-1 [--deliver-to "a1|a2|city|ST|zip"] --yes
//
// ORDERDESK_UPGRADE_WRITES is armed for this process only. GCHAT_WEBHOOK_URL
// from the environment; never printed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { makePaidHandler } from '../src/functions/shopify-paid/core.mjs';
import { applyShippingUpgrade } from '../src/shared/orderdesk-write.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../src/shared/orderdesk-fetch.mjs';
import { sendChat } from '../src/shared/gchat.mjs';
import { centsToDollars } from '../src/shared/money.mjs';
import { stillAllowed } from '../src/shared/paid-recheck.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const die = (m) => { console.error(m); process.exit(1); };
const orderName = process.argv[2];
if (!orderName || !process.argv.includes('--yes')) die('usage: <S-number> --orderdesk-id N --from X --to Y --shipping-cents N --tax-cents N --ref R --yes');

const dt = arg('deliver-to');
const [address1, address2, city, province, zip] = dt ? dt.split('|') : [];
const change = {
  orderName, orderDeskId: arg('orderdesk-id'), ref: arg('ref'), from: arg('from'), to: arg('to'),
  shippingCents: Number(arg('shipping-cents')), taxCents: Number(arg('tax-cents') ?? 0),
  deliverTo: dt ? { address1, address2, city, province, zip, country: 'US' } : undefined,
  status: 'pending', test: true,
};

// Snapshot for scripts/upgrade-roundtrip.mjs restore.
const snapDir = path.join(os.tmpdir(), 'sb-upgrade-roundtrip');
const snapFile = path.join(snapDir, `${orderName}.json`);
if (fs.existsSync(snapFile)) die(`snapshot exists, restore first: ${snapFile}`);
const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${change.orderDeskId}`, { headers: orderDeskHeaders() });
const before = (await res.json()).order;
fs.mkdirSync(snapDir, { recursive: true });
fs.writeFileSync(snapFile, JSON.stringify(before, null, 2));
console.log(`snapshot saved (${before.shipping_method}, total ${before.order_total})`);

const SECRET = crypto.randomBytes(16).toString('hex');   // stands in for the app's webhook secret
let store = { ...change };
const handler = makePaidHandler({
  webhookSecret: async () => SECRET,
  loadPending: async (name) => (name === orderName ? store : null),
  markDone: async (_n, ref) => { store = { ...store, status: 'done', doneRef: ref }; },
  markAttention: async (_n, ref, why) => { store = { ...store, status: 'attention', why }; console.log(`flagged: ${why}`); },
  stillAllowed: async (c) => stillAllowed((await (await orderDeskFetch(`${ORDERDESK_API}/orders/${c.orderDeskId}`, { headers: orderDeskHeaders() })).json()).order, c),
  applyOrderDesk: async (c) => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    try {
      return await applyShippingUpgrade({
        orderDeskId: c.orderDeskId, orderName: c.orderName, toMethod: c.to,
        amount: centsToDollars(c.shippingCents), tax: centsToDollars(c.taxCents), invoiceRef: c.ref, deliverTo: c.deliverTo,
      });
    } finally { delete process.env.ORDERDESK_UPGRADE_WRITES; }
  },
  notify: async (name, text) => { console.log(`chat text: "${text}"`); return sendChat({ webhookUrl: process.env.GCHAT_WEBHOOK_URL, orderName: name, text }); },
});

const raw = JSON.stringify({ name: `#${orderName}`, financial_status: 'paid' });
const event = { body: raw, headers: {
  'X-Shopify-Topic': 'orders/paid',
  'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64'),
} };

for (const round of [1, 2]) {
  const r = await handler(event);
  console.log(`webhook #${round}: ${r.statusCode} ${r.body}`);
  if (round === 1) store = { ...store, status: 'pending' };   // pretend markDone was lost, to hit the Order Desk duplicate guard
}
const after = (await (await orderDeskFetch(`${ORDERDESK_API}/orders/${change.orderDeskId}`, { headers: orderDeskHeaders() })).json()).order;
console.log(`Order Desk now: ${after.shipping_method}, shipping ${after.shipping_total}, tax ${after.tax_total}, total ${after.order_total}, notes ${(after.order_notes ?? []).length}`);
