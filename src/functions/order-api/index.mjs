// Order-API Lambda (Week 6, extended for the staff dashboard).
//
// Read-only order lookups from the DynamoDB jobs table, behind the
// Cognito-protected HTTP API:
//   GET /orders?status=<status>   list orders in a status (GSI1 query)
//   GET /orders/{name}            one order's META record (+ customerProofUrl
//                                 while it waits for the customer)
//   POST /orders/{name}/size      { choice: swap|keep } for an order resize held
//                                 as size-swapped; re-runs it (size-decision.mjs)
//
// Also callable directly with { orderName } for scripts/tests.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getGroup } from '../../shared/secrets.mjs';
import { customerProofLink } from './customer-link.mjs';
import { applySizeDecision } from './size-decision.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const JOBS_TABLE = process.env.JOBS_TABLE;
const INTAKE_QUEUE_URL = process.env.INTAKE_QUEUE_URL;

// Statuses mirror the OrderDesk folders staff already know.
const STATUSES = [
  'in_queue', 'printing', 'proofing', 'needs_review', 'awaiting_admin', 'awaiting_payment',
  'pickup_ga', 'pickup_nj', 'pickup_tx', 'pickup_nv', 'pickup_ca', 'completed', 'failed',
];

const resp = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

// Only synthetic demo orders may be hand-moved between folders (hard safety
// guard — a real order's status must never be changed from the dashboard).
const isDemoName = (name) => /^(DEMO|ZZ)-/i.test(String(name ?? ''));

export async function handler(event) {
  const orderName = event?.pathParameters?.name ?? event?.orderName;
  const method = event?.requestContext?.http?.method ?? event?.httpMethod;

  // --- demo move: POST /orders/{name}/move  { status } ---
  // Manually drives a DEMO-* order to any folder (for a live walkthrough of the
  // pipeline). Display-only: it just rewrites the status + GSI1 keys; it never
  // runs the pipeline, sends email, or transfers files.
  const isMove = method === 'POST'
    && (event?.rawPath?.endsWith('/move') || event?.routeKey?.includes('/move'));
  if (isMove) {
    if (!orderName) return resp(400, { error: 'missing order name' });
    if (!isDemoName(orderName)) return resp(403, { error: 'move is demo-only (DEMO-*/ZZ-* orders)' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
    const status = body.status;
    if (!STATUSES.includes(status)) {
      return resp(400, { error: `status must be one of ${STATUSES.join(', ')}` });
    }
    const cur = await ddb.send(
      new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } }),
    );
    if (!cur.Item) return resp(404, { error: 'not found', orderName });
    if (!cur.Item.demo && !isDemoName(cur.Item.orderName)) {
      return resp(403, { error: 'move is demo-only' });
    }
    const sortKey = cur.Item.createdAt || new Date().toISOString();
    const names = { '#s': 'status' };
    const values = { ':s': status, ':g': `STATUS#${status}`, ':k': sortKey };
    let expr = 'SET #s = :s, GSI1PK = :g, GSI1SK = :k';
    // Show a "· resizing/finishing/making proof" sub-label while in Printing.
    if (status === 'printing') { expr += ', stage = :st'; values[':st'] = body.stage || 'resizing'; } else { expr += ' REMOVE stage'; }
    const upd = await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { PK: `ORDER#${orderName}`, SK: 'META' },
      UpdateExpression: expr,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return resp(200, upd.Attributes);
  }

  // --- size decision: POST /orders/{name}/size  { choice } ---
  const isSize = method === 'POST'
    && (event?.rawPath?.endsWith('/size') || event?.routeKey?.includes('/size'));
  if (isSize) {
    if (!orderName) return resp(400, { error: 'missing order name' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
    const cur = await ddb.send(
      new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } }),
    );
    const claims = event?.requestContext?.authorizer?.jwt?.claims ?? {};
    const by = claims.email || claims['cognito:username'] || claims.username || 'staff';
    const out = applySizeDecision(cur.Item, body.choice, { by });
    if (out.error) return resp(out.code, { error: out.error, orderName });

    // Back to In Queue, only if it is still the hold we just read: two people
    // clicking at once must not start two runs.
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { PK: `ORDER#${orderName}`, SK: 'META' },
      UpdateExpression: 'SET #s = :q, GSI1PK = :g, #i = :items, sizeDecision = :d REMOVE #h, stage',
      ConditionExpression: '#s = :held AND #h.reason = :why',
      ExpressionAttributeNames: { '#s': 'status', '#i': 'items', '#h': 'hold' },
      ExpressionAttributeValues: {
        ':q': 'in_queue', ':g': 'STATUS#in_queue', ':items': out.items, ':d': out.decision,
        ':held': 'needs_review', ':why': 'size-swapped',
      },
    }));
    await sqs.send(new SendMessageCommand({
      QueueUrl: INTAKE_QUEUE_URL,
      MessageBody: JSON.stringify(out.job),
      MessageGroupId: 'intake',
      // The poller dedupes on the order name; a re-run needs its own id.
      MessageDeduplicationId: `${orderName}-size-${Date.now()}`,
    }));
    return resp(200, { orderName, status: 'in_queue', decision: out.decision });
  }

  // --- single order ---
  if (orderName) {
    const res = await ddb.send(
      new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } }),
    );
    if (!res.Item) return resp(404, { error: 'not found', orderName });
    // The customer approval page, so staff can open what the customer sees.
    // Never fails the lookup: no settings, no link.
    if (res.Item.status === 'proofing') {
      try {
        const url = customerProofLink(res.Item, await getGroup('approval'));
        if (url) return resp(200, { ...res.Item, customerProofUrl: url });
      } catch (err) {
        console.warn('could not mint the customer proof link', err);
      }
    }
    return resp(200, res.Item);
  }

  // --- all folder counts in one call: GET /orders?counts=1 ---
  // The dashboard needs a number per folder on every refresh. It used to ask
  // for each status separately — 12 parallel invocations every 20s, each one
  // paging the ENTIRE order list just to read .count. That burst is what
  // produced the intermittent 503s. Select:'COUNT' also means DynamoDB never
  // ships the items.
  if (event?.queryStringParameters?.counts !== undefined) {
    const entries = await Promise.all(STATUSES.map(async (s) => {
      let total = 0;
      let ExclusiveStartKey;
      do {
        const res = await ddb.send(
          new QueryCommand({
            TableName: JOBS_TABLE,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :s',
            ExpressionAttributeValues: { ':s': `STATUS#${s}` },
            Select: 'COUNT',
            ExclusiveStartKey,
          }),
        );
        total += res.Count ?? 0;
        ExclusiveStartKey = res.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return [s, total];
    }));
    return resp(200, { counts: Object.fromEntries(entries) });
  }

  // --- list by status (GSI1: GSI1PK = STATUS#<status>, newest first) ---
  const status = event?.queryStringParameters?.status ?? 'in_queue';
  if (!STATUSES.includes(status)) {
    return resp(400, { error: `status must be one of ${STATUSES.join(', ')}` });
  }
  // Page through the whole status — no 100-item cap, so the count grows with
  // the real order volume.
  const orders = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: JOBS_TABLE,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :s',
        ExpressionAttributeValues: { ':s': `STATUS#${status}` },
        ScanIndexForward: false, // newest first
        ExclusiveStartKey,
      }),
    );
    orders.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return resp(200, { status, count: orders.length, orders });
}
