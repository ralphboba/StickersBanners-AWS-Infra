// Order-API Lambda (Week 5 skeleton).
//
// Read-only order/job status lookups from the DynamoDB jobs table. Wired to API
// Gateway in Week 6; for now it accepts a simple { orderName } event.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;

/**
 * @param {{ orderName?: string }} event  e.g. { orderName: "S42166" }
 */
export async function handler(event) {
  const orderName = event?.orderName;
  if (!orderName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'orderName required' }) };
  }

  const res = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } }),
  );

  if (!res.Item) {
    return { statusCode: 404, body: JSON.stringify({ error: 'not found', orderName }) };
  }
  return { statusCode: 200, body: JSON.stringify(res.Item) };
}
