// OrderDesk webhook receiver (Week 6 skeleton).
//
// Public HTTP endpoint (POST /webhook/orderdesk) that OrderDesk calls the
// moment an order is created — replacing the poll loop with a push. It:
//   1. verifies a shared secret header (OrderDesk can't present a Cognito JWT),
//   2. parses the full OrderDesk order JSON into our cleaned "job" shape,
//   3. enqueues the job on the intake FIFO queue + records META in DynamoDB.
//
// The OrderDesk payload field paths are best-effort (based on a sample order)
// and marked TODO where they must be confirmed against the live API.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret } from '../../shared/secrets.mjs';
import { cleanOrder } from '../../shared/orderdesk.mjs';

const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INTAKE_QUEUE_URL = process.env.INTAKE_QUEUE_URL;
const JOBS_TABLE = process.env.JOBS_TABLE;
const SECRET_HEADER = (process.env.WEBHOOK_SECRET_HEADER ?? 'x-orderdesk-secret').toLowerCase();

const json = (statusCode, obj) => ({ statusCode, body: JSON.stringify(obj) });

/**
 * API Gateway (HTTP API, payload v2) Lambda proxy handler.
 */
export async function handler(event) {
  // --- 1. authenticate the caller ---
  const provided = (event.headers ?? {})[SECRET_HEADER];
  const expected = await getSecret('orderdesk', 'webhook-secret');
  if (!provided || provided !== expected) {
    return json(401, { error: 'unauthorized' });
  }

  // --- 2. parse + clean the order ---
  let order;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
    order = JSON.parse(raw ?? '{}');
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  const job = cleanOrder(order);
  if (!job.orderName) {
    return json(400, { error: 'missing order id' });
  }

  // --- 3. record + enqueue ---
  await ddb.send(
    new PutCommand({
      TableName: JOBS_TABLE,
      Item: {
        PK: `ORDER#${job.orderName}`,
        SK: 'META',
        GSI1PK: 'STATUS#received',
        GSI1SK: job.createdAt,
        status: 'received',
        ...job,
      },
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

  console.log(JSON.stringify({ msg: 'webhook accepted', orderName: job.orderName }));
  return json(202, { accepted: true, orderName: job.orderName });
}
