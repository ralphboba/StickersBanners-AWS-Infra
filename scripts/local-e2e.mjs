#!/usr/bin/env node
// The real customer flow, end to end, on ONE test order, from a laptop.
//
//   node --env-file=scripts/local-e2e.env scripts/local-e2e.mjs S64262
//
// What it runs is the deployed code, not a copy: the customer page
// (web/my-order.html), the order-status routes including "Send me the invoice"
// (order-status-api/routes.mjs) and the payment handler (shopify-paid/core.mjs).
// Only the parts AWS would provide are swapped for local ones:
//   · DynamoDB row       -> read live from Order Desk (+ the Shopify status URL)
//   · pending change     -> a JSON file in the temp directory
//   · SSM secrets        -> scripts/local-e2e.env (git-ignored)
//   · a public URL       -> a Cloudflare quick tunnel (`brew install cloudflared`)
//
// Safety:
//   · SHOPIFY_WRITES and ORDERDESK_UPGRADE_WRITES are armed for THIS process,
//     and WRITE_ONLY_ORDERS limits both to the order named on the command line.
//     Any other order is refused by the write gates themselves.
//   · the page and API answer for that order only; everything else is 404.
//   · the balance invoice goes to INVOICE_TO, never to the order's email.
//   · the Shopify webhooks it registers point at the tunnel and are deleted
//     again on Ctrl-C.
//
// Undo afterwards: Shopify (order edit back to the old line) and Order Desk
// (scripts/upgrade-roundtrip.mjs restore) — the same as the earlier tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeHandler } from '../src/functions/order-status-api/routes.mjs';
import { makePaidHandler } from '../src/functions/shopify-paid/core.mjs';
import { makeShopifyCredentials } from '../src/shared/shopify-auth.mjs';
import { fetchOrderForPricing, quoteShippingChange, deliveryEstimates } from '../src/shared/shopify-pricing.mjs';
import { commitShippingChange, sendBalanceInvoice } from '../src/shared/shopify-order-edit.mjs';
import { fetchOrderByName } from '../src/shared/shopify-orders.mjs';
import { cleanOrder } from '../src/shared/orderdesk.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../src/shared/orderdesk-fetch.mjs';
import { applyShippingUpgrade } from '../src/shared/orderdesk-write.mjs';
import { stillAllowed } from '../src/shared/paid-recheck.mjs';
import { sendChat } from '../src/shared/gchat.mjs';
import { centsToDollars } from '../src/shared/money.mjs';
import { isSyntheticOrder } from '../src/shared/write-gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

// ── setup ─────────────────────────────────────────────────────────────────
const ORDER = String(process.argv[2] ?? '').trim().replace(/^#/, '').toUpperCase();
if (!/^S\d+$/.test(ORDER) || isSyntheticOrder(ORDER)) die('usage: scripts/local-e2e.mjs <S-number>   (one real test order)');

const env = (k) => { const v = String(process.env[k] ?? '').trim(); if (!v) die(`${k} is missing from scripts/local-e2e.env`); return v; };
const SHOP = String(process.env.SHOPIFY_SHOP ?? 'stickersbanners.myshopify.com').trim();
const CLIENT_ID = env('SHOPIFY_CLIENT_ID');
const CLIENT_SECRET = env('SHOPIFY_CLIENT_SECRET');
const OD_STORE = env('ORDERDESK_STORE_ID');
const OD_KEY = env('ORDERDESK_API_KEY');
const CHAT_URL = env('GCHAT_WEBHOOK_URL');
const INVOICE_TO = env('INVOICE_TO');
const PORT = Number(arg('port', 8787));

// Writes on, for this order only (write-gates.mjs refuses every other name).
process.env.SHOPIFY_WRITES = 'enabled';
process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
process.env.WRITE_ONLY_ORDERS = ORDER;

// Test folders the stage rules do not know. For the test order only, they are
// read as Proofing (before production: every upgrade still open).
const TEST_FOLDER_AS = { 711436: '651474' }; // Kai-TEST-processed -> Proofing
const stageFolder = (id) => TEST_FOLDER_AS[String(id)] ?? String(id);

const creds = makeShopifyCredentials({
  getSecret: async (_g, key) => ({ 'shop-domain': SHOP, 'client-id': CLIENT_ID, 'client-secret': CLIENT_SECRET })[key],
});
const odHeaders = (extra) => orderDeskHeaders(OD_STORE, OD_KEY, extra);

// ── pending change store (stands in for the JOBS table's CHANGE row) ──────
const STATE_DIR = path.join(os.tmpdir(), 'sb-local-e2e');
const STATE = path.join(STATE_DIR, `${ORDER}.json`);
fs.mkdirSync(STATE_DIR, { recursive: true });
const readChange = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null);
const writeChange = (c) => fs.writeFileSync(STATE, JSON.stringify(c, null, 2));
const log = (msg, extra) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ''}`);

// ── live reads ────────────────────────────────────────────────────────────
async function orderDeskOrder() {
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders?source_id=${encodeURIComponent(ORDER)}`, { headers: odHeaders() });
  if (!res.ok) throw new Error(`Order Desk search ${res.status}`);
  const found = ((await res.json())?.orders ?? []).filter((o) => o.source_id === ORDER);
  if (found.length !== 1) throw new Error(`expected one Order Desk order ${ORDER}, found ${found.length}`);
  return found[0];
}
async function orderDeskById(id) {
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${id}`, { headers: odHeaders() });
  if (!res.ok) throw new Error(`Order Desk GET ${res.status}`);
  return (await res.json()).order;
}

let statusUrl = null;
async function loadRow(orderName) {
  if (orderName !== ORDER) return undefined;   // nothing else exists here
  const od = await orderDeskOrder();
  return { ...cleanOrder(od), folderId: stageFolder(od.folder_id), orderStatusUrl: statusUrl };
}

// ── the two handlers, wired like their Lambdas ────────────────────────────
const statusApi = makeHandler({
  loadRow,
  loadShopifyOrder: async (name) => fetchOrderForPricing({ ...(await creds()), orderName: name }),
  quote: async (a) => {
    try { return await quoteShippingChange({ ...(await creds()), ...a }); } catch (err) {
      log('quote failed', { err: String(err) }); return { ok: false, reason: 'shopify_error' };
    }
  },
  estimates: async (a) => { try { return await deliveryEstimates({ ...(await creds()), ...a }); } catch { return null; } },
  loadPending: async (name) => (name === ORDER ? readChange() : null),
  savePending: async (change) => {
    const cur = readChange();
    if (cur?.status === 'pending') throw new Error('a pending change already exists');
    writeChange({ ...change, test: true });
    log(`pending change saved: ${change.from} → ${change.to}, balance $${centsToDollars(change.shippingCents + change.taxCents).toFixed(2)}`);
  },
  commitEdit: async (a) => {
    const r = await commitShippingChange({ ...(await creds()), ...a });
    log('Shopify order edit commit', r);
    return r;
  },
  sendInvoice: async (a) => {
    const r = await sendBalanceInvoice({ ...(await creds()), ...a, to: INVOICE_TO });
    log(`balance invoice → ${INVOICE_TO}`, r);
    return r;
  },
  now: () => Date.now(),
});

const paid = makePaidHandler({
  webhookSecret: async () => CLIENT_SECRET,   // app webhooks are signed with the client secret
  loadPending: async (name) => (name === ORDER ? readChange() : null),
  markDone: async (_n, ref, result) => { writeChange({ ...readChange(), status: 'done', doneRef: ref, result }); log('change marked done'); },
  markAttention: async (_n, ref, why) => { writeChange({ ...readChange(), status: 'attention', attentionReason: why }); log(`flagged for the team: ${why}`); },
  stillAllowed: async (c) => {
    const od = await orderDeskById(c.orderDeskId);
    return stillAllowed({ ...od, folder_id: stageFolder(od.folder_id) }, c);
  },
  applyOrderDesk: async (c) => {
    const r = await applyShippingUpgrade({
      orderDeskId: c.orderDeskId, orderName: c.orderName, toMethod: c.to,
      amount: centsToDollars(c.shippingCents), tax: centsToDollars(c.taxCents ?? 0),
      invoiceRef: c.ref, deliverTo: c.deliverTo, storeId: OD_STORE, apiKey: OD_KEY,
    });
    log('Order Desk write', { applied: r.applied, skipped: r.skipped, error: r.error });
    return r;
  },
  notify: async (name, text) => { const r = await sendChat({ webhookUrl: CHAT_URL, orderName: name, text }); log(`Google Chat: "${text}"`, r); return r; },
});

// ── HTTP ──────────────────────────────────────────────────────────────────
const PAGE = fs.readFileSync(path.join(ROOT, 'web', 'my-order.html'));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const send = (r) => { res.writeHead(r.statusCode ?? 200, { 'Content-Type': 'application/json', ...(r.headers ?? {}) }); res.end(r.body ?? ''); };
  try {
    if (req.method === 'GET' && (url.pathname === '/my-order' || url.pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); return;
    }
    if (url.pathname.startsWith('/api/my-order')) {
      const r = await statusApi({
        httpMethod: req.method, path: url.pathname.replace(/^\/api/, ''),
        queryStringParameters: Object.fromEntries(url.searchParams), body,
      });
      if (req.method === 'POST') log(`${url.pathname} → ${r.statusCode} ${r.body}`);
      send(r); return;
    }
    if (req.method === 'POST' && url.pathname === '/webhook/shopify') {
      const r = await paid({ body, headers: req.headers });
      const topic = req.headers['x-shopify-topic'];
      if (!String(r.body).includes('"ignored"')) log(`webhook ${topic} → ${r.statusCode} ${r.body}`);
      send(r); return;
    }
    res.writeHead(404); res.end();
  } catch (err) {
    log('request failed', { path: url.pathname, err: String(err) });
    res.writeHead(500); res.end();
  }
});

// ── Shopify webhooks (pointing at the tunnel) ─────────────────────────────
async function adminGraphQL(query, variables) {
  const { token } = await creds();
  const res = await fetch(`https://${SHOP}/admin/api/2025-07/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}
const CREATE = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`;
const webhookIds = [];
async function subscribe(publicUrl, orderId) {
  for (const topic of ['ORDERS_PAID', 'ORDERS_UPDATED']) {
    // Filtered to the test order, so other customers' orders are not sent here.
    const sub = { uri: `${publicUrl}/webhook/shopify`, format: 'JSON' };
    let r = (await adminGraphQL(CREATE, { topic, sub: { ...sub, filter: `id:${orderId}` } })).webhookSubscriptionCreate;
    if (r.userErrors.length) {
      // Without the filter every order's event reaches this laptop; the handler
      // ignores all but the test order's pending change.
      log(`filter refused for ${topic} (${r.userErrors.map((e) => e.message).join('; ')}); registering unfiltered`);
      r = (await adminGraphQL(CREATE, { topic, sub })).webhookSubscriptionCreate;
    }
    if (r.userErrors.length) die(`webhook ${topic} not registered: ${JSON.stringify(r.userErrors)}`);
    webhookIds.push(r.webhookSubscription.id);
  }
  log('Shopify webhooks registered (orders/paid, orders/updated → this laptop)');
}
async function unsubscribe() {
  for (const id of webhookIds.splice(0)) {
    try {
      await adminGraphQL('mutation($id: ID!){ webhookSubscriptionDelete(id: $id){ deletedWebhookSubscriptionId userErrors{ message } } }', { id });
    } catch (err) { console.error(`could not delete webhook ${id}: ${err}`); }
  }
  log('Shopify webhooks deleted');
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { reject(err); return; }
    child.on('error', () => reject(new Error('cloudflared not found — install it with: brew install cloudflared')));
    const seek = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) resolve({ url: m[0], child });
    };
    child.stdout.on('data', seek);
    child.stderr.on('data', seek);
    setTimeout(() => reject(new Error('cloudflared gave no URL within 30s')), 30_000);
  });
}

// ── go ────────────────────────────────────────────────────────────────────
const order = await fetchOrderByName({ ...(await creds()), orderName: ORDER });
if (!order?.statusPageUrl) die(`Shopify order ${ORDER} not found`);
statusUrl = order.statusPageUrl;
const orderId = String(order.id).split('/').pop();
const od = await orderDeskOrder();
log(`${ORDER}: Order Desk ${od.shipping_method}, folder ${od.folder_id}; pending change: ${readChange()?.status ?? 'none'}`);

await new Promise((r) => server.listen(PORT, r));
let tunnel;
try { tunnel = await startTunnel(); } catch (err) { server.close(); die(err.message); }
log(`tunnel: ${tunnel.url}`);
await new Promise((r) => setTimeout(r, 4000)); // let the tunnel's DNS settle
await subscribe(tunnel.url, orderId);

const link = `${tunnel.url}/my-order?o=${encodeURIComponent(ORDER)}&s=${encodeURIComponent(statusUrl)}`;
console.log(`\n  Open this link (it is what the "Manage my order" button opens):\n\n  ${link}\n`);
console.log(`  Invoices go to ${INVOICE_TO}. Writes are limited to ${ORDER}. Ctrl-C to stop.\n`);

let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  console.log('\nstopping…');
  await unsubscribe();
  tunnel.child.kill();
  server.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
