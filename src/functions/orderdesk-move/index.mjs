// OrderDesk folder move for the steps after intake — see core.mjs for which
// folder, from where, and why (Linh's answers, 2026-10-05).
//
// Invoked by the pipeline with { job: <the whole state>, step }. Never throws
// for an OrderDesk problem: a move that could not happen is recorded on the
// order (META.orderDeskMoves) and the print job carries on, exactly as the
// poller treats its intake move. Only a bug in this function fails the call,
// and the workflow catches that too.
//
// The write itself is updateOrderDeskDetails, held by ORDERDESK_WRITES like
// every other OrderDesk write. With the switch off nothing is read or written
// in OrderDesk — not even the credentials — and the record says what WOULD
// have happened.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { getSecret } from '../../shared/secrets.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../../shared/orderdesk-fetch.mjs';
import { updateOrderDeskDetails } from '../../shared/orderdesk-write.mjs';
import { isSyntheticOrder, orderDeskWritesEnabled } from '../../shared/write-gates.mjs';
import { TEST_FOLDERS, isTestLaneJob } from '../../shared/test-lane.mjs';
import { planMove, checkFrom } from './core.mjs';

// A skipped move has no tag value (and, held, no OrderDesk response): drop the
// empty fields rather than fail the record. Without this every record threw
// on its first live run (2026-10-07, S66745) and nothing was written.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

async function record(orderName, entry) {
  await ddb.send(new UpdateCommand({
    TableName: process.env.JOBS_TABLE,
    Key: { PK: `ORDER#${orderName}`, SK: 'META' },
    UpdateExpression: 'SET orderDeskMoves = list_append(if_not_exists(orderDeskMoves, :empty), :e)',
    ExpressionAttributeValues: { ':e': [entry], ':empty': [] },
  }));
}

async function move(job, step) {
  const orderName = job?.orderName;
  // Kai's test lane: the same moves between the Kai-TEST-* folders, not held
  // by ORDERDESK_WRITES (shared/test-lane.mjs). checkFrom below still insists
  // the order is in the test folder the step expects.
  const testLane = isTestLaneJob(job);
  const plan = planMove(job, step, testLane ? TEST_FOLDERS : undefined);
  if (plan.skip) return { step, applied: false, skipped: plan.skip };

  const intent = { step, folder: plan.folder, folderId: plan.folderId, ...(testLane ? { testLane: true } : {}) };
  if (isSyntheticOrder(orderName) || (!testLane && !orderDeskWritesEnabled())) {
    // updateOrderDeskDetails logs and returns without touching OrderDesk.
    const r = await updateOrderDeskDetails({ order: null, orderName, folder: plan.folder });
    return { ...intent, ...r };
  }

  const storeId = await getSecret('orderdesk', 'store-id');
  const apiKey = await getSecret('orderdesk', 'api-key');
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${job.source.orderDeskId}`, {
    headers: orderDeskHeaders(storeId, apiKey),
  });
  if (!res.ok) {
    return { ...intent, applied: false, error: `OrderDesk GET ${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  const order = (await res.json())?.order;
  const where = checkFrom(order?.folder_id, plan);
  if (where !== 'move') {
    console.log(JSON.stringify({ msg: `orderdesk move skipped (${where})`, orderName, ...intent, folderNow: order?.folder_id }));
    return { ...intent, applied: false, skipped: where, folderNow: String(order?.folder_id ?? '') };
  }
  const r = await updateOrderDeskDetails({ order, orderName, folder: plan.folder, storeId, apiKey, testLane });
  return { ...intent, ...r };
}

/** @param {{ job: object, step: 'proofing'|'review'|'facility' }} event */
export async function handler(event) {
  const { job, step } = event ?? {};
  let result;
  try {
    result = await move(job, step);
  } catch (err) {
    result = { step, applied: false, error: String(err?.message ?? err) };
  }
  if (result.error) console.error(JSON.stringify({ msg: 'orderdesk move failed', orderName: job?.orderName, ...result }));
  if (job?.orderName) await record(job.orderName, { ...result, at: new Date().toISOString() });
  return result;
}
