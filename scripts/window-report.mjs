#!/usr/bin/env node
//
// The window ledger: every order this system touched, and where it actually
// sits in OrderDesk right now.
//
// Kai's requirement for 5PM: "have a full report of all the orders and where
// they are in OrderDesk." The point is that it reads OrderDesk rather than our
// own DynamoDB record of what we THINK we did -- if the two disagree, that
// disagreement is the most important thing on the page, so both are shown side
// by side and mismatches are called out.
//
// This container cannot reach app.orderdesk.me (the egress proxy blocks it), so
// every OrderDesk read goes through the poller Lambda's read-only `probe` mode,
// which is a plain GET returning raw text. Nothing here writes anything.
//
// Usage:
//   node scripts/window-report.mjs              # table to stdout
//   node scripts/window-report.mjs --json out.json
//
// Requires: aws CLI v2 with credentials configured.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TMP = mkdtempSync(join(tmpdir(), 'sbreport-'));

// Folders that matter tonight. The three Kai-TEST ones are where our orders
// should be; the QTS folder is what we left behind; Linh's real folders are the
// leak check -- an order of ours appearing in one of those means the folder
// redirection did not hold, and that is a five-alarm finding, not a footnote.
const FOLDERS = [
  { id: '711436', name: 'Kai-TEST-processed', ours: true },
  { id: '711437', name: 'Kai-TEST-manual', ours: true },
  { id: '711438', name: 'Kai-TEST-sales', ours: true },
  { id: '665685', name: 'QTS (left behind)', ours: false },
  { id: '650227', name: "Linh's processing", ours: false, leak: true },
  { id: '652268', name: "Linh's manual", ours: false, leak: true },
  { id: '657836', name: "Linh's sales", ours: false, leak: true },
  { id: '651474', name: "Linh's proofing", ours: false, leak: true },
];

/** The shell's AWS_* vars are placeholders here; real creds are in ~/.aws. */
function aws(args) {
  return execFileSync('env', ['-u', 'AWS_ACCESS_KEY_ID', '-u', 'AWS_SECRET_ACCESS_KEY', 'aws', ...args],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Read-only OrderDesk GET, via the poller's probe mode. Returns raw text. */
function probeRaw(path) {
  const out = join(TMP, `probe-${Math.random().toString(36).slice(2)}.json`);
  aws(['lambda', 'invoke', '--function-name', 'sb-dev-poller', '--region', REGION,
    '--payload', JSON.stringify({ probe: path }), out]);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  if (res.status !== 200) throw new Error(`probe ${path} -> HTTP ${res.status}`);
  return res.body;
}

// The probe truncates its response body at 12,000 characters, and order size
// varies enormously by folder: an order sitting in the proofing folder
// serializes to about 2,900 characters, but one in QTS carries its full item and
// file metadata and runs to 6,400 -- a single order, already half the budget. So
// the page size cannot be a constant. Start at three and halve on a parse
// failure; a lone order too big even for its own request falls back to reading
// the name straight out of the truncated text, because a name is all this report
// needs and an order we cannot name is the one thing it must not silently drop.
const MAX_PER_FOLDER = 400;

/** Pull order names out of a body that was cut off mid-JSON. */
function namesFromTruncated(body) {
  // Deliberately order-independent: OrderDesk does not guarantee that "id"
  // precedes "source_id", and a regex that assumed it silently returned nothing
  // for the one folder whose orders are biggest -- which stalled the whole walk.
  const out = [];
  for (const m of body.matchAll(/"source_id":"([^"]+)"/g)) out.push({ name: m[1], id: '', partial: true });
  return out;
}

/** One page, shrinking the request until it parses. */
function page(folderId, offset) {
  let total = null;
  for (const limit of [3, 1]) {
    const body = probeRaw(`orders?folder_id=${folderId}&limit=${limit}&offset=${offset}`);
    try {
      const parsed = JSON.parse(body);
      return {
        limit,
        total: Number(parsed.total_records ?? 0),
        orders: (parsed.orders ?? []).map((o) => ({
          name: o.source_id || o.email_address || String(o.id),
          id: String(o.id),
          date: o.date_added,
        })),
      };
    } catch {
      // total_records sits near the end of the body, so a truncated response
      // does not carry it. Fall through to the smaller request.
      if (limit === 1) return { limit, total, orders: namesFromTruncated(body) };
    }
  }
  return { limit: 1, total, orders: [] };
}

/** Every order in a folder, paged. */
function ordersIn(folderId) {
  const names = [];
  const seen = new Set();
  let truncated = false;
  let partial = false;
  let total = null;

  for (let offset = 0; ; ) {
    const p = page(folderId, offset);
    if (p.total) total = p.total;
    for (const o of p.orders) {
      if (o.partial) partial = true;
      if (seen.has(o.name)) continue;
      seen.add(o.name);
      names.push(o);
    }
    // Advance by the page size we ASKED for, never by what came back. A single
    // order too large to survive truncation yields nothing parseable, and
    // advancing by its count (zero) would spin on it forever -- or, if treated
    // as the end of the folder, silently drop every order behind it. That is
    // what left 21 of the proofing folder's 88 orders out of an earlier run.
    offset += p.limit;
    if (total !== null && offset >= total) break;
    if (total === null && p.orders.length < p.limit) break;
    if (names.length >= MAX_PER_FOLDER) { truncated = true; break; }
  }
  return { names, truncated, partial, total };
}

/** Our own record: the META row the pipeline wrote for each order. */
function ourRows() {
  const raw = aws(['dynamodb', 'scan', '--table-name', 'sb-dev-jobs', '--region', REGION,
    '--filter-expression', 'SK = :m', '--expression-attribute-values',
    JSON.stringify({ ':m': { S: 'META' } }), '--output', 'json']);
  const rows = new Map();
  for (const item of JSON.parse(raw).Items ?? []) {
    // Mirror rows are display-only copies, not something the pipeline ran.
    if (item.mirror?.BOOL === true) continue;
    const name = item.PK?.S?.replace(/^ORDER#/, '') ?? '';
    if (!name) continue;
    // Synthetic sandbox orders live only in DynamoDB -- they are not in
    // OrderDesk at all, so every one would read "NOT FOUND" and bury the real
    // orders this report exists to account for.
    if (/^(DEMO|ZZ)-/.test(name)) continue;
    rows.set(name, {
      status: item.status?.S ?? '?',
      facility: item.routing?.M?.facility?.S ?? item.facility?.S ?? '?',
      gate: item.hold?.M?.reason?.S ?? item.gate?.M?.reason?.S ?? '',
      updatedAt: item.updatedAt?.S ?? item.createdAt?.S ?? '',
    });
  }
  return rows;
}

const report = { generatedAt: new Date().toISOString(), folders: {}, leaks: [], orders: {} };

for (const f of FOLDERS) {
  let list = [];
  let truncated = false;
  let partial = false;
  let total = null;
  try {
    ({ names: list, truncated, partial, total } = ordersIn(f.id));
  } catch (err) {
    report.folders[f.name] = { id: f.id, error: String(err.message) };
    continue;
  }
  report.folders[f.name] = { id: f.id, count: list.length, truncated, partial, total };
  for (const o of list) {
    report.orders[o.name] ??= { orderDeskFolder: f.name, orderDeskFolderId: f.id, orderDeskId: o.id };
  }
}

const mine = ourRows();
for (const [name, row] of mine) {
  report.orders[name] = { ...(report.orders[name] ?? { orderDeskFolder: 'NOT FOUND', orderDeskFolderId: '' }), ours: row };
}

// The leak check, stated as its own finding rather than left for the reader to
// spot in a long table.
for (const [name, o] of Object.entries(report.orders)) {
  const f = FOLDERS.find((x) => x.id === o.orderDeskFolderId);
  if (o.ours && f?.leak) report.leaks.push({ name, folder: f.name });
}

const jsonAt = process.argv.indexOf('--json');
if (jsonAt !== -1 && process.argv[jsonAt + 1]) {
  writeFileSync(process.argv[jsonAt + 1], JSON.stringify(report, null, 2));
}

// --- printed form -----------------------------------------------------------
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
console.log(`OrderDesk ledger @ ${report.generatedAt}\n`);
for (const [fname, f] of Object.entries(report.folders)) {
  const note = f.error ? `ERROR ${f.error}` : `${f.count} orders${f.truncated ? ` (capped at ${MAX_PER_FOLDER})` : ''}${f.partial ? ' [some names salvaged from truncated responses]' : ''}${f.total != null && f.total !== f.count && !f.truncated ? ` -- WARNING: OrderDesk says ${f.total}` : ''}`;
  console.log(`  ${pad(fname, 22)} ${note}   (${f.id})`);
}

const touched = Object.entries(report.orders).filter(([, o]) => o.ours);
console.log(`\nOrders this system processed: ${touched.length}\n`);
console.log(`  ${pad('order', 10)} ${pad('our status', 14)} ${pad('fac', 4)} ${pad('gate', 20)} where it is in OrderDesk`);
for (const [name, o] of touched.sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${pad(name, 10)} ${pad(o.ours.status, 14)} ${pad(o.ours.facility, 4)} ${pad(o.ours.gate || '-', 20)} ${o.orderDeskFolder}`);
}

if (report.leaks.length) {
  console.log(`\n  *** ${report.leaks.length} ORDER(S) IN LINH'S REAL FOLDERS -- the redirection did not hold ***`);
  for (const l of report.leaks) console.log(`      ${l.name} -> ${l.folder}`);
} else {
  console.log(`\n  No order of ours reached one of Linh's real folders.`);
}

const stranded = touched.filter(([, o]) => o.orderDeskFolder === 'NOT FOUND');
if (stranded.length) {
  console.log(`\n  ${stranded.length} order(s) we processed are in none of the folders checked:`);
  for (const [n] of stranded) console.log(`      ${n}`);
}
