// Wiring for the orders/paid handler (logic in core.mjs).
//
// Pending change record: JOBS_TABLE, PK ORDER#<name>, SK CHANGE — written when
// the customer's order edit is committed:
//   { ref, orderDeskId, from, to, shippingCents, taxCents, deliverTo?, status }
//
// Secrets (SSM, never logged): /sb/<env>/shopify/webhook-secret,
// /sb/<env>/orderdesk/{store-id,api-key}, /sb/<env>/gchat/webhook-url.
// Not yet deployed: the CDK route and the Shopify webhook subscription are the
// remaining steps (docs/pricing-and-tax.md).

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { getSecret } from '../../shared/secrets.mjs';
import { applyShippingUpgrade } from '../../shared/orderdesk-write.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from '../../shared/orderdesk-fetch.mjs';
import { stillAllowed } from '../../shared/paid-recheck.mjs';
import { sendChat } from '../../shared/gchat.mjs';
import { centsToDollars } from '../../shared/money.mjs';
import { makePaidHandler } from './core.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;
const key = (orderName) => ({ PK: `ORDER#${orderName}`, SK: 'CHANGE' });

export const handler = makePaidHandler({
  webhookSecret: () => getSecret('shopify', 'webhook-secret'),
  loadPending: async (orderName) => (await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: key(orderName) })))?.Item ?? null,
  markDone: async (orderName, ref, result) => {
    await ddb.send(new UpdateCommand({
      TableName: JOBS_TABLE, Key: key(orderName),
      UpdateExpression: 'SET #s = :done, doneAt = :at, orderTotal = :t',
      ConditionExpression: '#r = :ref',
      ExpressionAttributeNames: { '#s': 'status', '#r': 'ref' },
      ExpressionAttributeValues: { ':done': 'done', ':at': new Date().toISOString(), ':ref': ref, ':t': result.orderTotal ?? null },
    }));
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
    return stillAllowed((await res.json())?.order, change);
  },
  applyOrderDesk: async (change) => {
    const [storeId, apiKey] = await Promise.all([getSecret('orderdesk', 'store-id'), getSecret('orderdesk', 'api-key')]);
    return applyShippingUpgrade({
      orderDeskId: change.orderDeskId, orderName: change.orderName, toMethod: change.to,
      amount: centsToDollars(change.shippingCents), tax: centsToDollars(change.taxCents ?? 0),
      invoiceRef: change.ref, deliverTo: change.deliverTo, storeId, apiKey,
    });
  },
  notify: async (orderName, text) => sendChat({ webhookUrl: await getSecret('gchat', 'webhook-url'), orderName, text }),
});
