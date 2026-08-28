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

  // mirror: DISPLAY-ONLY sync of real QTS orders onto the dashboard. Upserts a
  // META record (status in_queue, mirror:true) for each real order so staff SEE
  // orders arriving — but NEVER enqueues, so the pipeline never runs: no resize/
  // finish/transfer, no email, no OrderDesk write. Purely "orders coming in".
  if (event?.mirror === true) {
    // Page through the WHOLE QTS folder (no 100 cap) so In Queue grows with the
    // real volume.
    const all = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const pu = `https://app.orderdesk.me/api/v2/orders?folder_id=${folderId}&limit=${pageSize}&offset=${offset}`;
      const pr = await fetch(pu, { headers: { 'ORDERDESK-STORE-ID': storeId, 'ORDERDESK-API-KEY': apiKey } });
      if (!pr.ok) throw new Error(`OrderDesk ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
      const page = (await pr.json()).orders ?? [];
      all.push(...page);
      if (page.length < pageSize) break;
    }

    const present = new Set();
    let mirrored = 0;
    for (const order of all) {
      const job = cleanOrder(order);
      if (!job.orderName) continue;
      present.add(job.orderName);
      await ddb.send(new PutCommand({
        TableName: JOBS_TABLE,
        Item: {
          PK: `ORDER#${job.orderName}`, SK: 'META',
          GSI1PK: 'STATUS#in_queue', GSI1SK: job.createdAt,
          status: 'in_queue', mirror: true, ...job,
        },
        // Only create/refresh a mirror row; never touch a processed order.
        ConditionExpression: 'attribute_not_exists(PK) OR mirror = :t',
        ExpressionAttributeValues: { ':t': true },
      })).catch((e) => { if (e?.name !== 'ConditionalCheckFailedException') throw e; });
      mirrored += 1;
    }

    // Prune mirror rows whose order has left the QTS folder, so In Queue reflects
    // the current folder rather than accumulating stale orders.
    let pruned = 0;
    let ExclusiveStartKey;
    do {
      const scan = await ddb.send(new ScanCommand({
        TableName: JOBS_TABLE,
        FilterExpression: 'SK = :meta AND mirror = :t',
        ExpressionAttributeValues: { ':meta': 'META', ':t': true },
        ProjectionExpression: 'PK, orderName',
        ExclusiveStartKey,
      }));
      for (const it of scan.Items ?? []) {
        if (!present.has(it.orderName)) {
          await ddb.send(new DeleteCommand({ TableName: JOBS_TABLE, Key: { PK: it.PK, SK: 'META' } }));
          pruned += 1;
        }
      }
      ExclusiveStartKey = scan.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    console.log(JSON.stringify({ msg: 'mirror sync (display-only)', polled: all.length, mirrored, pruned }));
    return { mirror: true, polled: all.length, mirrored, pruned };
  }

  if (dryRun) {
    const inspected = orders.map((order) => {
      const job = cleanOrder(order);
      return {
        orderName: job.orderName,
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
