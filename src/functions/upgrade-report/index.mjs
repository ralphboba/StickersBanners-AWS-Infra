// Every morning: yesterday's shipping-upgrade count, emailed to Kai only.
//
//   { "date": "2026-10-03" }   optional — any day; default is yesterday (New York)
//   { "send": false }          optional — return the numbers without emailing
//
// Reads the UPGRADELOG#<day> rows (src/shared/upgrade-log.mjs) and publishes
// to the SNS topic REPORT_TOPIC_ARN, whose only subscriber is Kai's address.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

import { nyYesterday, summarize, dailyEmail } from '../../shared/upgrade-log.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

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
  const { subject, body } = dailyEmail(date, items);
  const send = event.send !== false;
  if (send) await sns.send(new PublishCommand({ TopicArn: process.env.REPORT_TOPIC_ARN, Subject: subject, Message: body }));
  console.log(JSON.stringify({ msg: 'upgrade report', date, summary, emailed: send }));
  return { date, ...summary, subject, body, emailed: send };
}
