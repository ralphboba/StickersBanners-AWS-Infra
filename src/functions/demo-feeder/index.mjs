// Demo feeder Lambda (safe sandbox).
//
// Keeps a small, fixed set of SYNTHETIC orders (DEMO-1..DEMO-N) flowing through
// the REAL pipeline so the dashboard continuously shows the system working
// exactly like the legacy program — with zero real-world effect:
//   * orders are named DEMO-* and carry demo:true, so notify-consumer sends no
//     real Zendesk email and the transfer container performs no real FTP/Drive.
//   * it never reads or writes real OrderDesk orders (the real poller stays OFF).
//
// Each tick it refreshes the first slot that is missing or finished
// (pickup_*/failed/awaiting_admin), re-seeding it and re-enqueuing to intake, so
// the board stays populated and active without unbounded growth.

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { cleanOrder } from '../../shared/orderdesk.mjs';

const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const INTAKE_QUEUE_URL = process.env.INTAKE_QUEUE_URL;
const JOBS_TABLE = process.env.JOBS_TABLE;
const DEMO_COUNT = Number(process.env.DEMO_COUNT) || 5;
const DEMO_ARTWORK = process.env.DEMO_ARTWORK || 'TEST001/art.png';

// A slot is "busy" (leave it alone) only while still moving through the pipeline.
const BUSY = new Set(['in_queue', 'printing', 'proofing']);

// Variety so the board looks like real traffic (size, finishing, destination).
const VARIANTS = [
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '10', H: '3', finish: 'Hem & Grommets', state: 'CA', zip: '90001' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '6', H: '4', finish: 'Pole Pockets (Top and Bottom)', state: 'NV', zip: '89101' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '4', H: '2', finish: 'No Hem / Grommets Only', state: 'GA', zip: '30301' },
  { name: "8'x8' Step & Repeat Banner Only", sku: 'SKUSR08X08BB', W: '8', H: '8', finish: 'Pole Pockets (Top Only)', state: 'CA', zip: '92101' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '3', H: '6', finish: 'Hem & Grommets', state: 'TX', zip: '75201' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '5', H: '2', finish: 'Cut Only', state: 'NJ', zip: '07001' },
];

function buildDemoJob(slot) {
  const v = VARIANTS[(slot - 1) % VARIANTS.length];
  const orderName = `DEMO-${slot}`;
  const order = {
    source_id: orderName, id: orderName, date_added: new Date().toISOString(),
    email: 'demo@stickersbanners.invalid', payment_status: 'paid',
    shipping: { first_name: 'Demo', last_name: `#${slot}`, state: v.state, postal_code: v.zip },
    shipping_method: 'FedEx Ground', order_total: 1, product_total: 1, currency: 'USD',
    // half of them require a proof so the board also shows the "proofing" stage
    customer_note: slot % 2 === 0 ? 'proof' : '',
    order_items: [{
      code: v.sku, name: v.name, quantity: 1,
      variation_list: { WIDTH: v.W, HEIGHT: v.H, 'FINISHING OPTIONS': v.finish, 'UPLOADED FILE': DEMO_ARTWORK },
      metadata: {},
    }],
  };
  const job = cleanOrder(order);
  job.items.forEach((it) => { it.artworkUrl = DEMO_ARTWORK; });
  job.demo = true; // belt-and-suspenders alongside the DEMO- name guard
  return job;
}

async function slotStatus(orderName) {
  const res = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' },
    ProjectionExpression: '#s', ExpressionAttributeNames: { '#s': 'status' },
  }));
  return res.Item?.status;
}

async function refreshSlot(job) {
  // Clear any prior sub-records for a clean re-run.
  for (const sk of ['META', 'APPROVAL', 'STEP#resize', 'STEP#finish', 'STEP#proof', 'STEP#transfer']) {
    await ddb.send(new DeleteCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${job.orderName}`, SK: sk } }));
  }
  await ddb.send(new PutCommand({
    TableName: JOBS_TABLE,
    Item: {
      PK: `ORDER#${job.orderName}`, SK: 'META',
      GSI1PK: 'STATUS#in_queue', GSI1SK: job.createdAt, status: 'in_queue', ...job,
    },
  }));
  await sqs.send(new SendMessageCommand({
    QueueUrl: INTAKE_QUEUE_URL,
    MessageBody: JSON.stringify(job),
    MessageGroupId: 'intake',
    MessageDeduplicationId: `${job.orderName}-${Date.now()}`,
  }));
}

export async function handler() {
  // Refresh the first slot that is free (missing or finished). One per tick keeps
  // the ECS footprint gentle while the board stays continuously active.
  for (let slot = 1; slot <= DEMO_COUNT; slot += 1) {
    const job = buildDemoJob(slot);
    const status = await slotStatus(job.orderName);
    if (status && BUSY.has(status)) continue; // still moving — leave it
    await refreshSlot(job);
    console.log(JSON.stringify({ msg: 'demo order fed', orderName: job.orderName, prevStatus: status ?? 'none' }));
    return { fed: job.orderName, prevStatus: status ?? 'none' };
  }
  console.log(JSON.stringify({ msg: 'demo board full — all slots busy' }));
  return { fed: null };
}
