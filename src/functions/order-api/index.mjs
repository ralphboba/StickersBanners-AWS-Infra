// Order-API Lambda (Week 6, extended for the staff dashboard).
//
// Read-only order lookups from the DynamoDB jobs table, behind the
// Cognito-protected HTTP API:
//   GET /orders?status=<status>   list orders in a status (GSI1 query)
//   GET /orders/{name}            one order's META record
//
// Also callable directly with { orderName } for scripts/tests.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;

const STATUSES = ['received', 'processing', 'manual_hold', 'done', 'failed'];

const resp = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(obj),
});

export async function handler(event) {
  const orderName = event?.pathParameters?.name ?? event?.orderName;

  // --- single order ---
  if (orderName) {
    const res = await ddb.send(
      new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } }),
    );
    if (!res.Item) return resp(404, { error: 'not found', orderName });
    return resp(200, res.Item);
  }

  // --- list by status (GSI1: GSI1PK = STATUS#<status>, newest first) ---
  const status = event?.queryStringParameters?.status ?? 'processing';
  if (!STATUSES.includes(status)) {
    return resp(400, { error: `status must be one of ${STATUSES.join(', ')}` });
  }
  const res = await ddb.send(
    new QueryCommand({
      TableName: JOBS_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :s',
      ExpressionAttributeValues: { ':s': `STATUS#${status}` },
      ScanIndexForward: false, // newest first
      Limit: 100,
    }),
  );
  return resp(200, { status, count: res.Items?.length ?? 0, orders: res.Items ?? [] });
}
