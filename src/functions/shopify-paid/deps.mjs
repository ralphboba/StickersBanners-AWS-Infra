// Live dependencies of the paid-change logic (core.mjs): the change record,
// Order Desk, Google Chat. Shared by the payment webhook (index.mjs) and the
// reconciler (functions/shipping-change-reconcile), so both settle a payment
// through exactly the same code.
//
// Pending change record: JOBS_TABLE, PK ORDER#<name>, SK CHANGE — written when
// the customer's order edit is committed:
//   { ref, orderDeskId, from, to, shippingCents, taxCents, deliverTo?, status }
//
// Secrets (SSM, never logged): /sb/<env>/shopify/client-secret (signs the webhook),
// /sb/<env>/orderdesk/{store-id,api-key}, /sb/<env>/gchat/webhook-url, and the
// facility spaces /sb/<env>/gchat/webhook-url-{GA,NJ,TX} (optional).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { getSecret } from '../../shared/secrets.mjs';
import { applyShippingUpgrade } from '../../shared/orderdesk-write.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../../shared/orderdesk-fetch.mjs';
import { stillAllowed } from '../../shared/paid-recheck.mjs';
import { notifyChat } from '../../shared/gchat.mjs';
import { chatFacilityOf } from '../../shared/orderdesk-folders.mjs';
import { centsToDollars } from '../../shared/money.mjs';
import { logItem } from '../../shared/upgrade-log.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;
const key = (orderName) => ({ PK: `ORDER#${orderName}`, SK: 'CHANGE' });

export const paidDeps = {
  // One settler at a time per change: orders/paid and orders/updated arrive
  // together for one payment, and the reconciler may run in the same second.
  // Each re-reads Order Desk before writing, but two that both read before
  // either writes would both add the money. The claim expires after 2 minutes
  // so a settler that died does not block the next try.
  claim: async (orderName, ref) => {
    const now = Date.now();
    try {
      await ddb.send(new UpdateCommand({
        TableName: JOBS_TABLE, Key: key(orderName),
        UpdateExpression: 'SET settlingAt = :now',
        ConditionExpression: '#r = :ref AND #s = :pending AND (attribute_not_exists(settlingAt) OR settlingAt < :stale)',
        ExpressionAttributeNames: { '#s': 'status', '#r': 'ref' },
        ExpressionAttributeValues: { ':now': now, ':stale': now - 2 * 60 * 1000, ':ref': ref, ':pending': 'pending' },
      }));
      return true;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  },
  release: async (orderName, ref) => {
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: key(orderName),
      UpdateExpression: 'REMOVE settlingAt',
      ConditionExpression: '#r = :ref',
      ExpressionAttributeNames: { '#r': 'ref' },
      ExpressionAttributeValues: { ':ref': ref },
    })).catch(() => {});
  },
  loadPending: async (orderName) => (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: key(orderName) })))?.Item ?? null,
  markDone: async (orderName, ref, result, change) => {
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: key(orderName),
      UpdateExpression: 'SET #s = :done, doneAt = :at, orderTotal = :t REMOVE settlingAt',
      ConditionExpression: '#r = :ref',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'ref' },
      ExpressionAttributeValues: { ':done': 'done', ':at': new Date().toISOString(), ':ref': ref, ':t': result.orderTotal ?? null },
    }));
    // Daily count (upgrade-log.mjs) — only a write that happened now, and
    // never at the cost of the 200 Shopify is waiting for.
    if (result.applied && change) {
      await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: logItem('paid', change, Date.now()) }))
        .catch((err) => console.warn(JSON.stringify({ msg: 'upgrade log failed', err: String(err) })));
    }
  },
  markAttention: async (orderName, ref, reason) => {
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: key(orderName),
      // alertedAt: the team was just told (in Chat, by the caller), so the
      // reconciler does not raise it a second time.
      UpdateExpression: 'SET #s = :a, attentionReason = :why, attentionAt = :at, alertedAt = :at REMOVE settlingAt',
      ConditionExpression: '#r = :ref',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'ref' },
      ExpressionAttributeValues: { ':a': 'attention', ':why': reason, ':at': new Date().toISOString(), ':ref': ref },
    }));
  },
  stillAllowed: async (change) => {
    const [storeId, apiKey] = await Promise.all([getSecret('orderdesk', 'store-id'), getSecret('orderdesk', 'api-key')]);
    const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${change.orderDeskId}`, { headers: orderDeskHeaders(storeId, apiKey) });
    if (!res.ok) throw new Error(`OrderDesk GET ${res.status}`);   // 500 -> Shopify retries
    const od = (await res.json())?.order;
    // The facility from the folder the order is in NOW picks the Chat space.
    return { ...stillAllowed(od, change), facility: od ? chatFacilityOf(od.folder_id, od.folder_name) : null };
  },
  applyOrderDesk: async (change) => {
    const [storeId, apiKey] = await Promise.all([getSecret('orderdesk', 'store-id'), getSecret('orderdesk', 'api-key')]);
    return applyShippingUpgrade({
      orderDeskId: change.orderDeskId, orderName: change.orderName, toMethod: change.to,
      amount: centsToDollars(change.shippingCents), tax: centsToDollars(change.taxCents ?? 0),
      invoiceRef: change.ref, deliverTo: change.deliverTo, storeId, apiKey,
      ...(change.addOns?.length ? { addOns: change.addOns, items: centsToDollars(change.itemsCents ?? 0) } : {}),
    });
  },
  notify: async (orderName, text, where = {}) => {
    const r = await notifyChat({ getUrl: (k) => getSecret('gchat', k), orderName, text, facility: where.facility });
    console.log(JSON.stringify({ msg: 'chat', orderName, sent: r.sent, skipped: r.skipped, facility: r.facility }));
    return r;
  },
};
