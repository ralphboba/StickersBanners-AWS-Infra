#!/usr/bin/env node
//
// Put orders back where Linh's program expects to find them.
//
// Linh's condition for switching his QTS scanning off on Sunday was: "create
// separate folders when you test in case something goes wrong so we don't have
// to figure out which orders need to be processed again". This is the other
// half of that — the undo. Everything our poller touches comes OUT of the QTS
// folder and nowhere else, so putting it back needs no manifest: whatever ended
// up in a test folder belongs in QTS.
//
// It must run somewhere that can reach app.orderdesk.me. The dev container
// cannot (the egress proxy blocks that host), so run it from a machine that
// can, with the store credentials in the environment:
//
//   ORDERDESK_STORE_ID=... ORDERDESK_API_KEY=... \
//     node scripts/restore-folders.mjs 900001 900002
//
// That lists what WOULD move and changes nothing. Add --apply to do it:
//
//   ... node scripts/restore-folders.mjs 900001 900002 --apply
//
// Dry run is the default on purpose. This script exists for the moment
// something has gone wrong, which is the worst moment to discover that a
// mistyped folder id moved 300 orders somewhere new.
//
// Options:
//   --apply            perform the moves (default: report only)
//   --to <folderId>    destination (default: the QTS folder, 665685)
//   --out <file>       also write the manifest as JSON, to hand to Linh
//
// The manifest lists every order moved, with the folder it came from, so the
// move can itself be undone.

import { writeFileSync } from 'node:fs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../src/shared/orderdesk-fetch.mjs';

/** Where the poller reads from, and so where everything belongs by default. */
const QTS_FOLDER_ID = '665685';
/** OrderDesk's list cap. */
const PAGE = 100;

function parseArgs(argv) {
  const folders = [];
  let apply = false;
  let to = QTS_FOLDER_ID;
  let out = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--to') { to = argv[i + 1]; i += 1; }
    else if (a === '--out') { out = argv[i + 1]; i += 1; }
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else folders.push(a);
  }
  if (folders.length === 0) throw new Error('give at least one source folder id');
  if (!/^\d+$/.test(String(to))) throw new Error(`--to must be a folder id, got: ${to}`);
  if (folders.includes(String(to))) throw new Error('a source folder cannot also be the destination');
  return { folders, apply, to, out };
}

async function listFolder(folderId, headers) {
  const orders = [];
  for (let offset = 0; ; offset += PAGE) {
    const q = new URLSearchParams({
      folder_id: String(folderId), limit: String(PAGE), offset: String(offset),
    });
    const res = await orderDeskFetch(`${ORDERDESK_API}/orders?${q}`, { headers });
    if (!res.ok) throw new Error(`list folder ${folderId}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()).orders ?? [];
    orders.push(...page);
    // A short page is the last page. The 2000 stop is a seatbelt: if a folder
    // id is wrong and matches something enormous, fail loudly rather than page
    // through a whole store.
    if (page.length < PAGE) break;
    if (orders.length >= 2000) throw new Error(`folder ${folderId} has 2000+ orders — is that id right?`);
  }
  return orders;
}

async function main() {
  const { folders, apply, to, out } = parseArgs(process.argv.slice(2));
  const storeId = process.env.ORDERDESK_STORE_ID;
  const apiKey = process.env.ORDERDESK_API_KEY;
  if (!storeId || !apiKey) throw new Error('set ORDERDESK_STORE_ID and ORDERDESK_API_KEY');
  const headers = orderDeskHeaders(storeId, apiKey);

  const moved = [];
  const failed = [];
  for (const folderId of folders) {
    const orders = await listFolder(folderId, headers);
    console.log(`folder ${folderId}: ${orders.length} order(s)`);
    for (const order of orders) {
      const row = {
        orderName: order.source_id ?? order.id,
        orderDeskId: String(order.id),
        from: String(folderId),
        to: String(to),
      };
      if (!apply) { moved.push({ ...row, applied: false }); continue; }

      const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${order.id}`, {
        method: 'PUT',
        headers: orderDeskHeaders(storeId, apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...order, folder_id: to }),
      });
      if (res.ok) {
        moved.push({ ...row, applied: true });
        console.log(`  moved ${row.orderName} ${folderId} -> ${to}`);
      } else {
        const body = (await res.text()).slice(0, 200);
        failed.push({ ...row, error: `${res.status}: ${body}` });
        console.error(`  FAILED ${row.orderName}: ${res.status} ${body}`);
      }
    }
  }

  const manifest = {
    ranAt: new Date().toISOString(),
    applied: apply,
    destination: String(to),
    sourceFolders: folders.map(String),
    moved,
    failed,
  };
  if (out) {
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`manifest written to ${out}`);
  }
  console.log(apply
    ? `\ndone: ${moved.length} moved, ${failed.length} failed`
    : `\nDRY RUN: ${moved.length} order(s) would move to ${to}. Re-run with --apply.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`restore-folders: ${err.message}`);
  process.exitCode = 1;
});
