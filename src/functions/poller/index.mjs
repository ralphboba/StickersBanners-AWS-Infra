// Poller Lambda.
//
// OrderDesk has no outbound webhook for this store, so — like the legacy bot —
// we PULL: on a schedule, read orders sitting in the OrderDesk "QTS" folder
// (where Shopify moves an order once it's ready to produce), clean each one,
// and enqueue it to the intake pipeline. Orders already recorded in DynamoDB
// are skipped, so re-polling the same folder is idempotent.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { getSecret } from '../../shared/secrets.mjs';
import { cleanOrder } from '../../shared/orderdesk.mjs';

const sqs = new SQSClient({});
// Real orders can carry undefined fields (missing totals/uploads); drop them.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const INTAKE_QUEUE_URL = process.env.INTAKE_QUEUE_URL;
const JOBS_TABLE = process.env.JOBS_TABLE;
const QTS_FOLDER_ID = process.env.QTS_FOLDER_ID;

// OrderDesk folder id -> dashboard status, for the display-only mirror.
// From Linh's constants (orderStatusLib / folderLib) and confirmed against live
// order counts. "Completed" is intentionally excluded (huge history, not useful).
const MIRROR_FOLDERS = {
  665685: 'in_queue',
  651474: 'proofing',
  661019: 'needs_review', // Missing/Corrupted File — orders that didn't process
  653109: 'needs_review', // Pending Review
  31358: 'awaiting_admin',
  31301: 'pickup_ga',
  52437: 'pickup_nj',
  52438: 'pickup_tx',
  674908: 'pickup_nv',    // "NV Awaiting Pickup" (correct NV folder id from /store)
  82463: 'pickup_ca',
};
const MAX_PER_FOLDER = 400; // safety cap per folder per sync

// Some real orders (non-banner products) have no WIDTH/HEIGHT -> NaN fields,
// which DynamoDB rejects. Drop NaN (and undefined) deeply for display-only rows.
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

async function fetchFolder(storeId, apiKey, folderId, max) {
  const out = [];
  const pageSize = 500;
  for (let offset = 0; out.length < max; offset += pageSize) {
    const u = `https://app.orderdesk.me/api/v2/orders?folder_id=${folderId}&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(u, { headers: { 'ORDERDESK-STORE-ID': storeId, 'ORDERDESK-API-KEY': apiKey } });
    if (!r.ok) throw new Error(`OrderDesk ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const page = (await r.json()).orders ?? [];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function alreadySeen(orderName) {
  const res = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' }, ProjectionExpression: 'PK' }),
  );
  return Boolean(res.Item);
}

async function enqueue(job) {
  await ddb.send(
    new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        PK: `ORDER#${job.orderName}`,
        SK: 'META',
        GSI1PK: 'STATUS#in_queue',
        GSI1SK: job.createdAt,
        status: 'in_queue',
        ...job,
      },
      // guard against a race with a concurrent poll
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: INTAKE_QUEUE_URL,
      MessageBody: JSON.stringify(job),
      MessageGroupId: 'intake',
      MessageDeduplicationId: job.orderName,
    }),
  );
}

export async function handler(event = {}) {
  const storeId = await getSecret('orderdesk', 'store-id');
  const apiKey = await getSecret('orderdesk', 'api-key');

  // probe: read-only GET of an arbitrary OrderDesk API path, for investigating
  // what the API exposes (store settings, folders, rules …). Returns raw text.
  if (event?.probe) {
    const u = `https://app.orderdesk.me/api/v2/${event.probe}`;
    const r = await fetch(u, { headers: { 'ORDERDESK-STORE-ID': storeId, 'ORDERDESK-API-KEY': apiKey } });
    const body = await r.text();
    return { probe: event.probe, status: r.status, body: body.slice(0, 12000) };
  }

  // mirror: DISPLAY-ONLY sync of real orders onto the dashboard, across all the
  // folders we show. Upserts a META row (mirror:true) with the folder's mapped
  // status so staff SEE the real operational board — but NEVER enqueues, so the
  // pipeline never runs (no resize/finish/transfer, no email, no OrderDesk write).
  // Cost-efficient: reads current state and only WRITES orders that are new or
  // whose folder/status changed; deletes those that left.
  if (event?.mirror === true) {
    // 1. current real orders across folders -> desired status. Orders the system
    //    can't fully handle are pulled aside into "needs_review": an unknown SKU
    //    (product not set up) or an intake order we can't route to a facility.
    const current = new Map(); // orderName -> { job, status }
    for (const [fid, folderStatus] of Object.entries(MIRROR_FOLDERS)) {
      const page = await fetchFolder(storeId, apiKey, fid, MAX_PER_FOLDER);
      for (const order of page) {
        const job = sanitize(cleanOrder(order));
        if (!job.orderName) continue;
        // Pull aside only genuine anomalies. (Unrouted is NOT one yet — the
        // GA/NJ/TX routing rules are incomplete, so every intake order is
        // unrouted; flagging all of them would make the folder meaningless.)
        const status = job.hasUnknownSku ? 'needs_review' : folderStatus;
        current.set(job.orderName, { job, status });
      }
    }

    // 2. what we already have mirrored
    const existing = new Map(); // orderName -> status
    let ESK;
    do {
      const scan = await ddb.send(new ScanCommand({
        TableName: JOBS_TABLE,
        FilterExpression: 'SK = :meta AND mirror = :t',
        ExpressionAttributeValues: { ':meta': 'META', ':t': true },
        ProjectionExpression: 'orderName, #s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExclusiveStartKey: ESK,
      }));
      for (const it of scan.Items ?? []) existing.set(it.orderName, it.status);
      ESK = scan.LastEvaluatedKey;
    } while (ESK);

    // 3. write only new/changed rows
    let wrote = 0;
    for (const [name, { job, status }] of current) {
      if (existing.get(name) === status) continue; // unchanged -> skip (no write)
      await ddb.send(new PutCommand({
        TableName: JOBS_TABLE,
        Item: {
          PK: `ORDER#${name}`, SK: 'META',
          GSI1PK: `STATUS#${status}`, GSI1SK: job.createdAt,
          status, mirror: true, ...job,
        },
        // Only create/refresh a mirror row; never touch a processed order.
        ConditionExpression: 'attribute_not_exists(PK) OR mirror = :t',
        ExpressionAttributeValues: { ':t': true },
      })).catch((e) => { if (e?.name !== 'ConditionalCheckFailedException') throw e; });
      wrote += 1;
    }

    // 4. delete mirror rows whose order left every mirrored folder
    let pruned = 0;
    for (const name of existing.keys()) {
      if (!current.has(name)) {
        await ddb.send(new DeleteCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${name}`, SK: 'META' } }));
        pruned += 1;
      }
    }

    // Surface any orders whose product isn't set up yet (unknown SKU).
    const unknown = [];
    for (const [name, { job }] of current) {
      if (job.hasUnknownSku) {
        unknown.push({ order: name, skus: (job.items || []).filter((i) => i.unknownSku).map((i) => i.sku) });
      }
    }
    if (unknown.length) console.warn(JSON.stringify({ msg: 'UNKNOWN SKU — needs review', count: unknown.length, unknown }));

    const summary = { mirror: true, folders: Object.keys(MIRROR_FOLDERS).length, total: current.size, wrote, pruned, unknownSku: unknown.length };
    console.log(JSON.stringify({ msg: 'mirror sync (display-only, multi-folder)', ...summary }));
    return summary;
  }

  // dryRun: fetch + clean real orders and RETURN the computed finishing/dims,
  // writing nothing and enqueuing nothing. Read-only — cannot affect real orders.
  const dryRun = event?.dryRun === true;
  const limit = Number(event?.limit) || 100;
  const folderId = event?.folderId || QTS_FOLDER_ID;

  const url = `https://app.orderdesk.me/api/v2/orders?folder_id=${folderId}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'ORDERDESK-STORE-ID': storeId, 'ORDERDESK-API-KEY': apiKey },
  });
  if (!res.ok) throw new Error(`OrderDesk ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { orders = [] } = await res.json();

  if (dryRun) {
    const inspected = orders.map((order) => {
      const job = cleanOrder(order);
      return {
        orderName: job.orderName,
        folder: job.folder,
        shipping: job.shipping,
        routing: job.routing,
        items: job.items.map((it) => ({
          sku: it.sku,
          name: it.name,
          width: it.width,
          height: it.height,
          unit: it.unit,
          finishingRaw: it.finishingRaw,
          finishingObj: it.finishingObj,
        })),
      };
    });
    return { dryRun: true, polled: orders.length, inspected };
  }

  let enqueued = 0;
  let skipped = 0;
  for (const order of orders) {
    const job = cleanOrder(order);
    if (!job.orderName) continue;
    if (await alreadySeen(job.orderName)) {
      skipped += 1;
      continue;
    }
    try {
      await enqueue(job);
      enqueued += 1;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        skipped += 1; // lost the race, another invocation took it
      } else {
        console.error('enqueue failed', job.orderName, err);
      }
    }
  }

  const summary = { polled: orders.length, enqueued, skipped };
  console.log(JSON.stringify({ msg: 'poll complete', ...summary }));
  return summary;
}
