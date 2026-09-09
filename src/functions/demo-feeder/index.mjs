// Demo feeder Lambda (safe sandbox).
//
// Keeps a small, fixed set of SYNTHETIC orders (DEMO-1..DEMO-N) flowing through
// the REAL pipeline so the dashboard continuously shows the system working
// exactly like the legacy program — with zero real-world effect:
//   * orders are named DEMO-* and carry demo:true, so notify-consumer sends no
//     real Zendesk email and the transfer container performs no real FTP/Drive.
//   * it never reads or writes real OrderDesk orders (the real poller stays OFF).
//
// Each tick it refreshes ONE slot — whichever free slot (pickup_*/failed/
// awaiting_admin/missing) was fed longest ago — re-seeding it and re-enqueuing
// to intake, so the board stays active without unbounded growth and every
// variant gets its turn through the image containers. See rotation.mjs for why
// "longest ago" and not "first free".

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { cleanOrder } from '../../shared/orderdesk.mjs';
import { chooseSlot } from './rotation.mjs';

const sqs = new SQSClient({});
// cleanOrder leaves some keys undefined by design (folder when OrderDesk sends
// no folder_name, proofName when a line item has no id). The document client
// throws on those unless told to drop them — the poller has always been
// configured this way; this one was not, and inherited the same job shape.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const INTAKE_QUEUE_URL = process.env.INTAKE_QUEUE_URL;
const JOBS_TABLE = process.env.JOBS_TABLE;
const DEMO_COUNT = Number(process.env.DEMO_COUNT) || 5;
const DEMO_ARTWORK = process.env.DEMO_ARTWORK || 'TEST001/art.png';

// Variety so the board looks like real traffic (size, finishing, destination).
// `fac` gives each demo order an explicit facility so the board spreads across
// all pickup folders — a DEMO-only convenience; real routing (routeOrder) is
// untouched. fac:null leaves it UNROUTED so the "Awaiting Admin" state shows too.
const VARIANTS = [
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '10', H: '3', finish: 'Hem & Grommets', fac: 'CA' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '6', H: '4', finish: 'Pole Pockets (Top and Bottom)', fac: 'NV' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '4', H: '2', finish: 'No Hem / Grommets Only', fac: 'GA' },
  { name: "8'x8' Step & Repeat Banner Only", sku: 'SKUSR08X08BB', W: '8', H: '8', finish: 'Pole Pockets (Top Only)', fac: 'NJ' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '3', H: '6', finish: 'Hem & Grommets', fac: 'TX' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '5', H: '2', finish: 'Cut Only', fac: null },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '8', H: '4', finish: 'Hem & Grommets', fac: 'CA' },
  { name: 'Custom Vinyl Banners', sku: 'SKUVB', W: '2', H: '8', finish: 'Pole Pockets (Top Only)', fac: 'GA' },
];

const TRANSPORT = { CA: 'GDRIVE', GA: 'FTP', NJ: 'FTP', TX: 'FTP', NV: 'FTP' };

function buildDemoJob(slot) {
  const v = VARIANTS[(slot - 1) % VARIANTS.length];
  const orderName = `DEMO-${slot}`;
  const order = {
    source_id: orderName, id: orderName, date_added: new Date().toISOString(),
    // Real store orders are named S##### and so take the Shopify parse path
    // (see orderVariant in shared/orderdesk.mjs). DEMO-* names would otherwise
    // fall to the QTS path, which reads artwork from metadata.image1..5 instead
    // of the variation list and would flag every demo order as missing its file.
    order_metadata: { 'First Rep': 'Shopify' },
    email: 'demo@stickersbanners.invalid', payment_status: 'paid',
    shipping: { first_name: 'Demo', last_name: `#${slot}`, state: v.fac ?? 'CA', postal_code: '00000' },
    shipping_method: 'FedEx Ground', order_total: 1, product_total: 1, currency: 'USD',
    // Half require a proof so the board also shows the "proofing" stage.
    // Legacy reads checkout_data.Note and treats any text that does not say
    // "no proof" as wanting one (see wantsProof in shared/orderdesk.mjs).
    checkout_data: { Note: slot % 2 === 0 ? 'Please send a proof' : 'no proof' },
    order_items: [{
      code: v.sku, name: v.name, quantity: 1,
      variation_list: { WIDTH: v.W, HEIGHT: v.H, 'FINISHING OPTIONS': v.finish, 'UPLOADED FILE': DEMO_ARTWORK },
      metadata: {},
    }],
  };
  const job = cleanOrder(order);
  job.items.forEach((it) => { it.artworkUrl = DEMO_ARTWORK; });
  job.demo = true; // belt-and-suspenders alongside the DEMO- name guard
  // DEMO-only: force an explicit facility so the board spreads across pickup
  // folders. fac:null stays UNROUTED (-> Awaiting Admin). Real orders unaffected.
  if (v.fac) {
    job.routing = { facility: v.fac, transport: TRANSPORT[v.fac], pickupStatus: `pickup_${v.fac.toLowerCase()}` };
  }
  return job;
}

async function slotState(slot, orderName) {
  const res = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' },
    ProjectionExpression: '#s, fedAt', ExpressionAttributeNames: { '#s': 'status' },
  }));
  return { slot, status: res.Item?.status, fedAt: res.Item?.fedAt };
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
      // Read back by chooseSlot next tick — this is what makes the rotation
      // "least recently fed" rather than "first free".
      fedAt: new Date().toISOString(),
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
  // One slot per tick keeps the ECS footprint gentle. WHICH slot is the whole
  // point: least recently fed, so every variant gets its turn (see rotation.mjs
  // — feeding the first free slot meant only DEMO-1 ever ran).
  const slots = await Promise.all(
    Array.from({ length: DEMO_COUNT }, (_, i) => slotState(i + 1, `DEMO-${i + 1}`)),
  );

  const slot = chooseSlot(slots);
  if (slot === null) {
    console.log(JSON.stringify({ msg: 'demo board full — all slots busy' }));
    return { fed: null };
  }

  const job = buildDemoJob(slot);
  const prev = slots.find((s) => s.slot === slot);
  await refreshSlot(job);
  console.log(JSON.stringify({
    msg: 'demo order fed',
    orderName: job.orderName,
    prevStatus: prev?.status ?? 'none',
    lastFedAt: prev?.fedAt ?? 'never',
  }));
  return { fed: job.orderName, prevStatus: prev?.status ?? 'none' };
}
