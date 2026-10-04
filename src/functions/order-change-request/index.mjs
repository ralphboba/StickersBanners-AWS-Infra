// "Send me the invoice" — POST /my-order/request (routes.mjs requestChange).
//
// A separate function from order-status-api on purpose: that one is reachable
// without authentication and is READ ONLY. This one may commit an order edit,
// email an invoice and write the pending change record, and every one of
// those is behind SHOPIFY_WRITES (shopify-order-edit.mjs) or a condition on
// the record.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

import { getSecret } from '../../shared/secrets.mjs';
import { makeShopifyCredentials } from '../../shared/shopify-auth.mjs';
import { fetchOrderForPricing, quoteShippingChange } from '../../shared/shopify-pricing.mjs';
import { commitShippingChange, sendBalanceInvoice, stageShippingChange } from '../../shared/shopify-order-edit.mjs';
import { makeHandler } from '../order-status-api/routes.mjs';
import { logItem } from '../../shared/upgrade-log.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;
const creds = makeShopifyCredentials({ getSecret });

const routes = makeHandler({
  loadRow: async (orderName) => (await ddb.send(new GetCommand({
    TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } })))?.Item,
  loadShopifyOrder: async (orderName) => fetchOrderForPricing({ ...(await creds()), orderName }),
  quote: async (args) => {
    try { return await quoteShippingChange({ ...(await creds()), ...args }); } catch (err) {
      console.warn(JSON.stringify({ msg: 'quote failed', err: String(err) }));
      return { ok: false, reason: 'shopify_error' };
    }
  },
  estimates: async () => null,
  loadPending: async (orderName) => (await ddb.send(new GetCommand({
    TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'CHANGE' } })))?.Item ?? null,
  // One open change per order: a second pending record is refused by the
  // table, not just by the route's earlier check.
  savePending: async (change) => {
    // Retiring an unpaid record (a switch) only if it is still that unpaid
    // one: if it was paid or replaced meanwhile, the put is refused.
    await ddb.send(new PutCommand({
      TableName: JOBS_TABLE,
      Item: { PK: `ORDER#${change.orderName}`, SK: 'CHANGE', ...change },
      ...(change.replaces
        ? { ConditionExpression: '#s = :pending AND #r = :old',
          ExpressionAttributeNames: { '#s': 'status', '#r': 'ref' },
          ExpressionAttributeValues: { ':pending': 'pending', ':old': change.replaces } }
        : { ConditionExpression: 'attribute_not_exists(PK) OR #s <> :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':pending': 'pending' } }),
    }));
    // Daily count (upgrade-log.mjs). Never fails the customer's request.
    if (change.status === 'pending') {
      await ddb.send(new PutCommand({ TableName: JOBS_TABLE, Item: logItem('requested', change, Date.now()) }))
        .catch((err) => console.warn(JSON.stringify({ msg: 'upgrade log failed', err: String(err) })));
    }
  },
  stageEdit: async (args) => stageShippingChange({ ...(await creds()), ...args }),
  commitEdit: async (args) => commitShippingChange({ ...(await creds()), ...args }),
  sendInvoice: async (args) => sendBalanceInvoice({ ...(await creds()), ...args }),
  now: () => Date.now(),
});

// { warmup: true } from the 5-minute schedule: load the Shopify token so the
// next customer does not wait for it, and return. Nothing else is touched.
export async function handler(event = {}) {
  if (event?.warmup === true) {
    try { await creds(); } catch (err) { console.warn(JSON.stringify({ msg: 'warmup token failed', err: String(err) })); }
    return { warm: true };
  }
  return routes(event);
}
