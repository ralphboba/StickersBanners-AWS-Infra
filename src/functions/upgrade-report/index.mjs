// Every morning: yesterday's shipping-upgrade count into the main Chat space.
//
//   { "date": "2026-10-03" }   optional — any day; default is yesterday (New York)
//   { "post": false }          optional — return the numbers without posting
//
// Reads the UPGRADELOG#<day> rows (src/shared/upgrade-log.mjs). Posts to
// /sb/<env>/gchat/webhook-url, the space that already gets every paid change.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { getSecret } from '../../shared/secrets.mjs';
import { sendChat } from '../../shared/gchat.mjs';
import { nyYesterday, summarize, dailyMessage } from '../../shared/upgrade-log.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(event.date ?? '') ? event.date : nyYesterday(Date.now());
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: process.env.JOBS_TABLE, KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `UPGRADELOG#${date}` }, ExclusiveStartKey,
    }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const summary = summarize(items);
  const text = dailyMessage(date, summary);
  const chat = event.post === false ? { sent: false, skipped: 'post_false' }
    : await sendChat({ webhookUrl: await getSecret('gchat', 'webhook-url'), orderName: 'REPORT', text });
  console.log(JSON.stringify({ msg: 'upgrade report', date, summary, chat: chat.sent }));
  return { date, ...summary, text, posted: chat.sent };
}
