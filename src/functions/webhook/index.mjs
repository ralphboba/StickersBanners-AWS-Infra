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
import { routeOrder } from '../../shared/routing.mjs';

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

/**
 * Map an OrderDesk order JSON into our cleaned job shape.
 * TODO(week6): confirm exact field paths against the live OrderDesk API.
 */
export function cleanOrder(order) {
  const items = (order.order_items ?? []).map((it) => {
    const md = metaMap(it.metadata);
    return {
      sku: it.code ?? md.SKU,
      name: it.name,
      quantity: Number(it.quantity ?? 1),
      widthFt: num(md.WIDTH),
      heightFt: num(md.HEIGHT),
      finishing: splitFinishing(md['FINISHING OPTIONS']),
      artworkUrl: md['UPLOADED FILE'],
    };
  });

  const shipping = {
    state: order.shipping?.state,
    postalCode: order.shipping?.postal_code,
    method: order.shipping_method,
    name: [order.shipping?.first_name, order.shipping?.last_name].filter(Boolean).join(' '),
  };

  // Dictionaries are empty until seeded — routeOrder returns UNROUTED for now.
  const routing = routeOrder(shipping);

  return {
    orderName: order.source_id ?? order.order_number ?? order.id,
    createdAt: toIso(order.date_added),
    folder: order.folder_name,
    financialStatus: order.checkout_data?.financial_status,
    customer: { email: order.email, name: shipping.name },
    shipping,
    routing,
    needsProof: wantsProof(order),
    totals: {
      subtotal: num(order.product_total),
      grandTotal: num(order.order_total),
      currency: order.currency ?? 'USD',
    },
    items,
    source: { shopifyOrderId: metaMap(order.order_metadata).shopify_order_id },
  };
}

// --- helpers ---------------------------------------------------------------

function metaMap(metadata) {
  // OrderDesk metadata can be an array of {name,value} or an object.
  if (Array.isArray(metadata)) {
    return Object.fromEntries(metadata.map((m) => [m.name, m.value]));
  }
  return metadata ?? {};
}

function splitFinishing(value) {
  // "Hem & Grommets" -> ["Hem", "Grommets"]
  if (!value) return [];
  return String(value)
    .split(/&|,|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function wantsProof(order) {
  const note = `${order.customer_note ?? ''} ${order.internal_note ?? ''}`.toLowerCase();
  return note.includes('proof');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toIso(v) {
  const d = v ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
