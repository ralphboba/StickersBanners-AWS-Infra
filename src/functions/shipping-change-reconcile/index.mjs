// Every 5 minutes: settle paid shipping changes the webhook missed, and tell
// the team about any that still cannot be applied (logic in core.mjs).
//
// Chat: /sb/<env>/gchat/webhook-url-alerts (Kai, 2026-10-06: the "shipping
// upgrade" space), falling back to the main /sb/<env>/gchat/webhook-url.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { getSecret } from '../../shared/secrets.mjs';
import { makeShopifyCredentials } from '../../shared/shopify-auth.mjs';
import { fetchOrderForPricing } from '../../shared/shopify-pricing.mjs';
import { sendChat } from '../../shared/gchat.mjs';
import { paidDeps } from '../shopify-paid/deps.mjs';
import { makeReconciler } from './core.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;
const key = (orderName) => ({ PK: `ORDER#${orderName}`, SK: 'CHANGE' });
const creds = makeShopifyCredentials({ getSecret });

const stamp = (field) => async (orderName, ref, at) => {
  await ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE, Key: key(orderName),
    UpdateExpression: `SET ${field} = :at`,
    ConditionExpression: '#r = :ref',
    ExpressionAttributeNames: { '#r': 'ref' },
    ExpressionAttributeValues: { ':at': new Date(at).toISOString(), ':ref': ref },
  }));
};

async function alertUrl() {
  try {
    const u = await getSecret('gchat', 'webhook-url-alerts');
    if (u) return u;
  } catch { /* not set: use the main space */ }
  return getSecret('gchat', 'webhook-url');
}

const reconcile = makeReconciler({
  ...paidDeps,
  listOpen: async () => {
    const out = [];
    let ESK;
    do {
      const page = await ddb.send(new ScanCommand({
        TableName: JOBS_TABLE,
        FilterExpression: 'SK = :c AND (#s = :p OR #s = :a)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':c': 'CHANGE', ':p': 'pending', ':a': 'attention' },
        ExclusiveStartKey: ESK,
      }));
      out.push(...(page.Items ?? []));
      ESK = page.LastEvaluatedKey;
    } while (ESK);
    return out;
  },
  shopifyOrder: async (orderName) => fetchOrderForPricing({ ...(await creds()), orderName }),
  markPaidSeen: stamp('paidSeenAt'),
  markAlerted: stamp('alertedAt'),
  alert: async (orderName, text) => {
    const r = await sendChat({ webhookUrl: await alertUrl(), orderName, text });
    console.log(JSON.stringify({ msg: 'reconcile alert', orderName, sent: r.sent, skipped: r.skipped, status: r.status }));
    return r;
  },
});

export const handler = () => reconcile();
