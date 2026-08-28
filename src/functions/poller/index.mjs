// Poller Lambda.
//
// OrderDesk has no outbound webhook for this store, so — like the legacy bot —
// we PULL: on a schedule, read orders sitting in the OrderDesk "QTS" folder
// (where Shopify moves an order once it's ready to produce), clean each one,
// and enqueue it to the intake pipeline. Orders already recorded in DynamoDB
// are skipped, so re-polling the same folder is idempotent.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
    let mirrored = 0;
    for (const order of orders) {
      const job = cleanOrder(order);
      if (!job.orderName) continue;
      await ddb.send(new PutCommand({
        TableName: JOBS_TABLE,
        Item: {
          PK: `ORDER#${job.orderName}`, SK: 'META',
          GSI1PK: 'STATUS#in_queue', GSI1SK: job.createdAt,
          status: 'in_queue', mirror: true, ...job,
        },
        // Only create/refresh a mirror row; never overwrite an order that is
        // actually being processed (defensive — real orders are never processed).
        ConditionExpression: 'attribute_not_exists(PK) OR mirror = :t',
        ExpressionAttributeValues: { ':t': true },
      })).catch((e) => { if (e?.name !== 'ConditionalCheckFailedException') throw e; });
      mirrored += 1;
    }
    console.log(JSON.stringify({ msg: 'mirror sync (display-only)', polled: orders.length, mirrored }));
    return { mirror: true, polled: orders.length, mirrored };
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
