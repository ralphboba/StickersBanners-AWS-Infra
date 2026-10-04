#!/usr/bin/env node
// Put ONE test order on the customer page, in a deployed environment.
//
//   node scripts/seed-test-row.mjs S64262 [--env dev]
//
// The customer page reads the order's row from the jobs table (the row the
// display-only mirror writes). The mirror only covers the real workflow
// folders, so a test order filed in a staff test folder never gets one. This
// writes that row the way the mirror would: the cleaned Order Desk record, its
// folder id, and the Shopify order-status URL that authorises the page.
//
// Reads credentials from SSM (/sb/<env>/...) with your AWS login; writes with
// `aws dynamodb put-item`. Writes nothing to Order Desk or Shopify.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const ORDER = String(process.argv[2] ?? '').trim().replace(/^#/, '').toUpperCase();
if (!/^S\d+$/.test(ORDER)) { console.error('usage: scripts/seed-test-row.mjs <S-number> [--env dev]'); process.exit(1); }
process.env.SB_ENV = arg('env', 'dev');

const { getSecret } = await import('../src/shared/secrets.mjs');
const { makeShopifyCredentials } = await import('../src/shared/shopify-auth.mjs');
const { fetchOrderByName } = await import('../src/shared/shopify-orders.mjs');
const { cleanOrder } = await import('../src/shared/orderdesk.mjs');
const { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } = await import('../src/shared/orderdesk-fetch.mjs');

const [storeId, apiKey] = await Promise.all([getSecret('orderdesk', 'store-id'), getSecret('orderdesk', 'api-key')]);
const res = await orderDeskFetch(`${ORDERDESK_API}/orders?source_id=${encodeURIComponent(ORDER)}`, { headers: orderDeskHeaders(storeId, apiKey) });
if (!res.ok) throw new Error(`Order Desk search ${res.status}`);
const found = ((await res.json())?.orders ?? []).filter((o) => o.source_id === ORDER);
if (found.length !== 1) throw new Error(`expected one Order Desk order ${ORDER}, found ${found.length}`);
const od = found[0];

const creds = makeShopifyCredentials({ getSecret });
const shopify = await fetchOrderByName({ ...(await creds()), orderName: ORDER });
if (!shopify?.statusPageUrl) throw new Error(`Shopify order ${ORDER} not found`);

// Same shape as the mirror's row (poller/index.mjs), NaN/undefined dropped.
const clean = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const c = clean(x); if (c !== undefined && c !== null && c !== '') o[k] = c; }
    return o;
  }
  return v;
};
const job = clean(cleanOrder(od));
const item = {
  ...job,
  PK: `ORDER#${ORDER}`, SK: 'META',
  GSI1PK: 'STATUS#proofing', GSI1SK: job.createdAt ?? new Date().toISOString(),
  // mirror: false so the mirror's prune never deletes it (it owns only its own rows).
  status: 'proofing', mirror: false, folderId: String(od.folder_id),
  orderStatusUrl: shopify.statusPageUrl,
  testOrder: true,
};

// DynamoDB JSON
const ddb = (v) => {
  if (v === null || v === undefined) return { NULL: true };
  if (typeof v === 'string') return { S: v };
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'boolean') return { BOOL: v };
  if (Array.isArray(v)) return { L: v.map(ddb) };
  return { M: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ddb(x)])) };
};
const file = path.join(os.tmpdir(), `sb-test-row-${ORDER}.json`);
fs.writeFileSync(file, JSON.stringify(ddb(item).M));
execFileSync('aws', ['dynamodb', 'put-item', '--table-name', `sb-${process.env.SB_ENV}-jobs`, '--item', `file://${file}`], { stdio: 'inherit' });
fs.unlinkSync(file);
console.log(`row written: ${ORDER} (${od.shipping_method}, folder ${od.folder_id})`);
