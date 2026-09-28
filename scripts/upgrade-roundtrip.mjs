#!/usr/bin/env node
// One-order test of the post-payment OrderDesk write, and its undo.
//
//   node scripts/upgrade-roundtrip.mjs apply   <S-number> --to "FedEx 3-Days" --amount 68.17 --tax 6.07 --yes
//   node scripts/upgrade-roundtrip.mjs restore <S-number> --yes
//
// apply    reads the order, saves the whole record to a snapshot file, runs the
//          real applyShippingUpgrade on it (the same code the paid webhook will
//          run), then reads it back and prints what changed.
// restore  PUTs the snapshot back and checks, field by field, that the order
//          matches what it was before.
//
// Credentials: either ORDERDESK_STORE_ID and ORDERDESK_API_KEY in the
// environment, or none at all when the session's egress proxy injects the
// OrderDesk headers for app.orderdesk.me (Claude Code "API credentials").
// Nothing is printed from them.
//
// The ORDERDESK_UPGRADE_WRITES switch is armed for this process alone, for this
// one order. The deployed switch is not touched.
//
// OrderDesk keeps its own history log of edits; this script cannot remove those
// entries, only restore the values.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { applyShippingUpgrade } from '../src/shared/orderdesk-write.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../src/shared/orderdesk-fetch.mjs';
import { folderById } from '../src/shared/orderdesk-folders.mjs';

const WATCHED = ['shipping_method', 'shipping_total', 'tax_total', 'order_total', 'folder_id'];
const SNAP_DIR = path.join(os.tmpdir(), 'sb-upgrade-roundtrip');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const die = (msg) => { console.error(msg); process.exit(1); };

const [, , mode, orderName] = process.argv;
if (!['apply', 'restore'].includes(mode) || !orderName) {
  die('usage: apply|restore <S-number> [--to "FedEx 3-Days" --amount 68.17 --tax 6.07] --yes');
}
const storeId = process.env.ORDERDESK_STORE_ID;
const apiKey = process.env.ORDERDESK_API_KEY;
if (Boolean(storeId) !== Boolean(apiKey)) die('Set both ORDERDESK_STORE_ID and ORDERDESK_API_KEY, or neither.');
if (!storeId) console.log('No OrderDesk keys in the environment: relying on proxy-injected headers.');

const headers = (extra) => orderDeskHeaders(storeId, apiKey, extra);

async function findOrder(name) {
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders?source_id=${encodeURIComponent(name)}`, { headers: headers() });
  if (!res.ok) die(`OrderDesk search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const found = ((await res.json())?.orders ?? []).filter((o) => o.source_id === name);
  if (found.length !== 1) die(`Expected exactly one OrderDesk order with source_id ${name}, found ${found.length}.`);
  return found[0];
}

async function readOrder(id) {
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${id}`, { headers: headers() });
  if (!res.ok) die(`OrderDesk GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).order;
}

function show(label, o) {
  const folder = folderById(o.folder_id);
  console.log(`\n${label}`);
  for (const k of WATCHED) console.log(`  ${k.padEnd(16)} ${o[k]}${k === 'folder_id' && folder ? ` (${folder.name})` : ''}`);
  console.log(`  ${'notes'.padEnd(16)} ${(o.order_notes ?? []).length}`);
}

const snapFile = (name) => path.join(SNAP_DIR, `${name}.json`);

if (mode === 'apply') {
  const to = arg('to');
  const amount = Number(arg('amount'));
  const tax = Number(arg('tax') ?? 0);
  if (!to || !(amount > 0)) die('apply needs --to and a positive --amount (and --tax, 0 if none).');

  const found = await findOrder(orderName);
  const before = await readOrder(found.id);
  show(`BEFORE  ${orderName} (OrderDesk ${before.id})`, before);

  if (fs.existsSync(snapFile(orderName))) die(`A snapshot already exists for ${orderName}. Restore first: ${snapFile(orderName)}`);
  if (!process.argv.includes('--yes')) die('\nNothing written. Re-run with --yes to apply.');

  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(snapFile(orderName), JSON.stringify(before, null, 2));
  console.log(`\nsnapshot saved: ${snapFile(orderName)}`);

  process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';   // this process only
  const r = await applyShippingUpgrade({
    orderDeskId: before.id, orderName, toMethod: to, amount, tax,
    invoiceRef: `TEST-${Date.now()}`, storeId, apiKey,
  });
  delete process.env.ORDERDESK_UPGRADE_WRITES;
  if (!r.applied) die(`not applied: ${JSON.stringify(r)}`);

  show('AFTER', await readOrder(before.id));
  console.log(`\nCheck it in OrderDesk, then: node scripts/upgrade-roundtrip.mjs restore ${orderName} --yes`);
}

if (mode === 'restore') {
  if (!fs.existsSync(snapFile(orderName))) die(`No snapshot for ${orderName} at ${snapFile(orderName)}.`);
  const snap = JSON.parse(fs.readFileSync(snapFile(orderName), 'utf8'));
  show('SNAPSHOT (restoring to)', snap);
  if (!process.argv.includes('--yes')) die('\nNothing written. Re-run with --yes to restore.');

  const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${snap.id}`, {
    method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(snap),
  });
  if (!res.ok) die(`OrderDesk PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const now = await readOrder(snap.id);
  show('NOW', now);
  const diffs = WATCHED.filter((k) => String(now[k]) !== String(snap[k]));
  if ((now.order_notes ?? []).length !== (snap.order_notes ?? []).length) diffs.push('order_notes');
  if (diffs.length) die(`\nNOT fully restored: ${diffs.join(', ')}. Snapshot kept at ${snapFile(orderName)}.`);
  fs.renameSync(snapFile(orderName), `${snapFile(orderName)}.restored`);
  console.log('\nRestored: every watched field matches the snapshot.');
}
