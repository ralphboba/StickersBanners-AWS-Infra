#!/usr/bin/env node
// Cancel an UNPAID shipping change on a test order, so it can be tried again
// from the "Manage my order" button.
//
//   node scripts/reset-test-change.mjs S64262 [--env dev]
//
// Does what the hourly expiry job does, now instead of after 48 hours: puts
// the original shipping line back on the Shopify order (no balance left) and
// deletes the pending change record. Refuses if the change was already paid.
// Credentials from SSM with your AWS login. Writes for the named order only.

import { execFileSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ORDER = String(process.argv[2] ?? '').trim().replace(/^#/, '').toUpperCase();
if (!/^S\d+$/.test(ORDER)) { console.error('usage: scripts/reset-test-change.mjs <S-number> [--env dev]'); process.exit(1); }
process.env.SB_ENV = arg('env', 'dev');
process.env.SHOPIFY_WRITES = 'enabled';
process.env.WRITE_ONLY_ORDERS = ORDER;

const { getSecret } = await import('../src/shared/secrets.mjs');
const { makeShopifyCredentials } = await import('../src/shared/shopify-auth.mjs');
const { fetchOrderForPricing } = await import('../src/shared/shopify-pricing.mjs');
const { stageShippingChange, commitShippingChange } = await import('../src/shared/shopify-order-edit.mjs');

const TABLE = `sb-${process.env.SB_ENV}-jobs`;
const KEY = JSON.stringify({ PK: { S: `ORDER#${ORDER}` }, SK: { S: 'CHANGE' } });
const aws = (args) => execFileSync('aws', args, { encoding: 'utf8' });

const item = JSON.parse(aws(['dynamodb', 'get-item', '--table-name', TABLE, '--key', KEY, '--output', 'json']) || '{}').Item;
if (!item) { console.log(`${ORDER}: no change record — nothing to reset.`); process.exit(0); }
const status = item.status?.S;
const restore = { title: item.restore?.M?.title?.S, priceCents: Number(item.restore?.M?.priceCents?.N) };
console.log(`${ORDER}: change ${item.ref?.S} ${item.from?.S} → ${item.to?.S}, status ${status}`);
if (status !== 'pending') { console.error('Not pending (already paid or flagged) — not touching it.'); process.exit(1); }

const creds = await makeShopifyCredentials({ getSecret })();
const order = await fetchOrderForPricing({ ...creds, orderName: ORDER });
if (!order) throw new Error('Shopify order not found');
if (order.outstandingCents <= 0) { console.error('The balance is already paid — not reverting.'); process.exit(1); }
const line = order.shippingLines[0];
if (order.shippingLines.length !== 1 || line.title !== item.to?.S) throw new Error(`unexpected shipping line: ${JSON.stringify(order.shippingLines)}`);

if (line.title !== restore.title) {
  const staged = await stageShippingChange({ ...creds, orderId: order.id, removeLineId: line.id, title: restore.title, priceCents: restore.priceCents });
  if (!staged.ok || staged.outstandingCents !== 0) throw new Error(`restore would not clear the balance: ${JSON.stringify(staged)}`);
  const done = await commitShippingChange({ ...creds, orderName: ORDER, calculatedOrderId: staged.calculatedOrderId,
    staffNote: `TEST reset: unpaid change ${item.ref?.S} cancelled, ${restore.title} restored` });
  if (!done.committed) throw new Error(`commit failed: ${JSON.stringify(done)}`);
  console.log(`Shopify: back on ${restore.title}, balance $${(done.outstandingCents / 100).toFixed(2)}`);
}
aws(['dynamodb', 'delete-item', '--table-name', TABLE, '--key', KEY]);
console.log('Pending change record deleted. The page will offer the options again.');
