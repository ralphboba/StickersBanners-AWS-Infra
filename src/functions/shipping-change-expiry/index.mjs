// Hourly: undo shipping changes left unpaid past revertAfter (core.mjs).
// The schedule ships DISABLED, like the poller; enabling it is a go-live step.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { getSecret } from '../../shared/secrets.mjs';
import { fetchOrderForPricing } from '../../shared/shopify-pricing.mjs';
import { stageShippingChange, commitShippingChange } from '../../shared/shopify-order-edit.mjs';
import { sendChat } from '../../shared/gchat.mjs';
import { makeExpiryJob } from './core.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;
const creds = async () => {
  const [shop, token] = await Promise.all([getSecret('shopify', 'shop-domain'), getSecret('shopify', 'admin-token')]);
  return { shop, token };
};
const setStatus = (change, status, extra = {}) => ddb.send(new UpdateCommand({
  TableName: JOBS_TABLE, Key: { PK: `ORDER#${change.orderName}`, SK: 'CHANGE' },
  UpdateExpression: `SET #s = :s, ${Object.keys(extra).map((k) => `${k} = :${k}`).concat('updatedAt = :at').join(', ')}`,
  ConditionExpression: '#r = :ref AND #s = :pending',
  ExpressionAttributeNames: { '#s': 'status', '#r': 'ref' },
  ExpressionAttributeValues: { ':s': status, ':ref': change.ref, ':pending': 'pending', ':at': new Date().toISOString(),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`:${k}`, v])) },
}));

const run = makeExpiryJob({
  // Few open changes at any time; a filtered scan is simplest and cheap.
  listPending: async () => (await ddb.send(new ScanCommand({
    TableName: JOBS_TABLE, FilterExpression: 'SK = :c AND #s = :p',
    ExpressionAttributeNames: { '#s': 'status' }, ExpressionAttributeValues: { ':c': 'CHANGE', ':p': 'pending' },
  })))?.Items ?? [],
  now: () => Date.now(),
  loadShopifyOrder: async (orderName) => fetchOrderForPricing({ ...(await creds()), orderName }),
  stage: async (p) => stageShippingChange({ ...(await creds()), ...p }),
  commit: async (p) => commitShippingChange({ ...(await creds()), ...p }),
  markExpired: (change) => setStatus(change, 'expired'),
  markAttention: (change, reason) => setStatus(change, 'attention', { attentionReason: reason }),
  notify: async (orderName, text) => sendChat({ webhookUrl: await getSecret('gchat', 'webhook-url'), orderName, text }),
});

export const handler = async () => ({ results: await run() });
