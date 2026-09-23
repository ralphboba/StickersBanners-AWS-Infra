#!/usr/bin/env node
//
// "Every order that came into OrderDesk yesterday — could we have processed it?"
//
// Kai, 2026-09-23: "every single day, every order, we check it and see if we can
// process it. If we can't process it, you gotta tell me."
//
// Two layers, because one is not enough:
//
//   1. The ORDER RECORD, via the poller's dryRun. Routing, the intake gate,
//      sizes, finishing, the proof verdict. Reads real orders, writes nothing,
//      enqueues nothing, emails nobody.
//   2. The CUSTOMER'S FILE, via src/services/resize/artwork_probe.py on the
//      resize task. Layer 1 is blind to it, and two of the three real failures
//      on 2026-09-19 lived there (a two-page PDF; a 120x96 in PDF page).
//      Only orders that CLEAR the gate are probed — a held order is already
//      going to a person, and its file is their problem, not the pipeline's.
//
// Nothing here can change an order, send an email or put a file anywhere near
// production. The poll schedule stays disabled throughout.
//
// Usage:
//   node scripts/daily-census.mjs                 # yesterday (America/New_York)
//   node scripts/daily-census.mjs 2026-09-22      # a specific day
//   node scripts/daily-census.mjs 2026-09-22 --no-artwork
//   node scripts/daily-census.mjs 2026-09-22 --max-files 40

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT = '025857592188';
const BUCKET = `sb-dev-processed-${ACCOUNT}`;
const CLUSTER = 'sb-dev-cluster';
const SUBNETS = ['subnet-018993d45375dd0cf', 'subnet-01fbb7cbf8829ee94'];
const SECURITY_GROUP = 'sg-02e34e0c092c574a4';
const TMP = mkdtempSync(join(tmpdir(), 'census-'));

/** The shell's AWS_* vars are placeholders here; real creds are in ~/.aws. */
function aws(args) {
  return execFileSync('env', ['-u', 'AWS_ACCESS_KEY_ID', '-u', 'AWS_SECRET_ACCESS_KEY', 'aws', ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** Yesterday in New York — the day that has actually finished. */
function yesterdayEastern() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const today = `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}-${parts.find((p) => p.type === 'day').value}`;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Layer 1: every order added that day, with our verdict for each. */
function census(day) {
  const out = join(TMP, 'dry.json');
  aws(['lambda', 'invoke', '--function-name', 'sb-dev-poller', '--region', REGION,
    '--payload', JSON.stringify({
      dryRun: true, all: true, folderId: null, since: day, until: day, limit: 100,
    }), out]);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  if (!res.inspected) throw new Error(`dryRun returned no census: ${JSON.stringify(res).slice(0, 300)}`);
  return res;
}

/** Every printable item of every order the gate would let through. */
function artworkQueue(inspected) {
  const queue = [];
  for (const order of inspected) {
    if (order.gate) continue; // already going to a person
    for (const item of order.items ?? []) {
      if (item.hardware) continue;
      queue.push({
        orderName: order.orderName,
        itemNo: item.itemNo,
        sku: item.sku,
        name: item.name,
        url: item.artworkUrl,
        artworkExt: item.artworkExt,
        width: item.width,
        height: item.height,
        unit: item.unit,
      });
    }
  }
  return queue;
}

/** Layer 2: run the probe on the resize task and wait for it. */
function probeArtwork(day, queue, maxFiles) {
  const inputKey = `_census/${day}/artwork-input.json`;
  const outputKey = `_census/${day}/artwork-report.json`;
  const local = join(TMP, 'input.json');
  writeFileSync(local, JSON.stringify(queue));
  aws(['s3', 'cp', local, `s3://${BUCKET}/${inputKey}`, '--region', REGION]);

  const runSpec = {
    cluster: CLUSTER,
    taskDefinition: 'sb-dev-resize',
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: SUBNETS,
        securityGroups: [SECURITY_GROUP],
        // dev has natGateways: 0, so a private subnet cannot even pull the image.
        assignPublicIp: 'ENABLED',
      },
    },
    overrides: {
      containerOverrides: [{
        name: 'resize',
        command: ['python', 'artwork_probe.py'],
        environment: [
          { name: 'PROBE_INPUT_BUCKET', value: BUCKET },
          { name: 'PROBE_INPUT_KEY', value: inputKey },
          { name: 'PROBE_OUTPUT_BUCKET', value: BUCKET },
          { name: 'PROBE_OUTPUT_KEY', value: outputKey },
          { name: 'PROBE_MAX_FILES', value: String(maxFiles) },
        ],
      }],
    },
  };
  const specPath = join(TMP, 'run.json');
  writeFileSync(specPath, JSON.stringify(runSpec));
  const arn = aws(['ecs', 'run-task', '--cluster', CLUSTER, '--task-definition', 'sb-dev-resize',
    '--region', REGION, '--cli-input-json', `file://${specPath}`,
    '--query', 'tasks[0].taskArn', '--output', 'text']).trim();
  const id = arn.split('/').pop();
  process.stderr.write(`artwork probe: task ${id} (${queue.length} files)\n`);

  // ecs wait tasks-stopped polls for up to 100 attempts at 6s — enough for a
  // few hundred downloads, and it is re-entered below if it gives up first.
  for (let round = 0; round < 6; round += 1) {
    try {
      aws(['ecs', 'wait', 'tasks-stopped', '--cluster', CLUSTER, '--tasks', id, '--region', REGION]);
      break;
    } catch { /* not finished yet — wait again */ }
  }
  const exit = aws(['ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', id, '--region', REGION,
    '--query', 'tasks[0].containers[0].exitCode', '--output', 'text']).trim();
  if (exit !== '0') throw new Error(`artwork probe exited ${exit}`);

  const reportPath = join(TMP, 'report.json');
  aws(['s3', 'cp', `s3://${BUCKET}/${outputKey}`, reportPath, '--region', REGION]);
  return JSON.parse(readFileSync(reportPath, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? yesterdayEastern();
  const withArtwork = !args.includes('--no-artwork');
  const maxFilesArg = args.indexOf('--max-files');
  const maxFiles = maxFilesArg === -1 ? 500 : Number(args[maxFilesArg + 1]);

  const { polled, inspected } = census(day);

  const gates = {};
  for (const o of inspected) {
    const key = o.gate ? o.gate.reason : 'would process';
    gates[key] = (gates[key] ?? 0) + 1;
  }

  // Anything that clears the gate but still cannot be made. Layer 1 should
  // leave none of these; one appearing is a hole in the gate, not a detail.
  const leaks = [];
  for (const o of inspected) {
    if (o.gate) continue;
    if (!o.routing?.facility) leaks.push({ order: o.orderName, why: 'no facility', detail: o.shipping?.state ?? '?' });
    for (const it of (o.items ?? []).filter((i) => !i.hardware)) {
      const w = Number(it.width); const h = Number(it.height);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        leaks.push({ order: o.orderName, why: 'no size', detail: `item ${it.itemNo} ${it.sku ?? ''}` });
      }
    }
  }

  const report = { day, polled, gates, leaks, artwork: null };
  if (withArtwork) {
    const queue = artworkQueue(inspected);
    report.artwork = queue.length ? probeArtwork(day, queue, maxFiles) : { checked: 0, counts: {}, results: [] };
  }

  // stdout is the report; stderr carries progress, so `> out.json` is clean.
  console.log(JSON.stringify(report, null, 2));
}

main();
