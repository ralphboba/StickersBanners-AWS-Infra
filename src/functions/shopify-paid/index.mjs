// Wiring for the orders/paid handler (logic in core.mjs).
//
// Pending change record: JOBS_TABLE, PK ORDER#<name>, SK CHANGE — written when
// the customer's order edit is committed:
//   { ref, orderDeskId, from, to, shippingCents, taxCents, deliverTo?, status }
//
// Secrets (SSM, never logged): /sb/<env>/shopify/client-secret (signs the webhook),
// /sb/<env>/orderdesk/{store-id,api-key}, /sb/<env>/gchat/webhook-url, and the
// facility spaces /sb/<env>/gchat/webhook-url-{GA,NJ,TX} (optional).
// Not yet deployed: the CDK route and the Shopify webhook subscription are the
// remaining steps (docs/pricing-and-tax.md).

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
import { makeShopifyCredentials } from '../../shared/shopify-auth.mjs';
import { sendBalanceInvoice } from '../../shared/shopify-order-edit.mjs';
import { makePaidHandler } from './core.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;
const key = (orderName) => ({ PK: `ORDER#${orderName}`, SK: 'CHANGE' });
const shopifyCreds = makeShopifyCredentials({ getSecret });

export const handler = makePaidHandler({
  // Webhooks this app subscribes to are signed with the app's Client secret.
  webhookSecret: () => getSecret('shopify', 'client-secret'),
  loadPending: async (orderName) => (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: key(orderName) })))?.Item ?? null,
  markDone: async (orderName, ref, result, change) => {
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: key(orderName),
      UpdateExpression: 'SET #s = :done, doneAt = :at, orderTotal = :t',
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
      UpdateExpression: 'SET #s = :a, attentionReason = :why, attentionAt = :at',
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
    });
  },
  // Shopify's own invoice email, to the order's email address; behind
  // SHOPIFY_WRITES (and WRITE_ONLY_ORDERS) like every Shopify write.
  sendInvoice: async (orderName, change) => sendBalanceInvoice({
    ...(await shopifyCreds()), orderName, orderId: change.shopifyOrderId,
    customMessage: `Your shipping has been upgraded to ${change.to}. Here is your updated invoice — thank you!`,
  }),
  notify: async (orderName, text, where = {}) => {
    const r = await notifyChat({ getUrl: (k) => getSecret('gchat', k), orderName, text, facility: where.facility });
    console.log(JSON.stringify({ msg: 'chat', orderName, sent: r.sent, skipped: r.skipped, facility: r.facility }));
    return r;
  },
});
