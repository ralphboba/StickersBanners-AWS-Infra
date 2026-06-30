// Approval API (Week 8).
//
// Backs POST /orders/{name}/approve and /reject (Cognito-protected). Looks up
// the order's stored task token and resumes the paused Step Functions execution:
//   approve -> SendTaskSuccess  (workflow continues to transfer/notify)
//   reject  -> SendTaskFailure  (workflow takes its failure path)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const JOBS_TABLE = process.env.JOBS_TABLE;

const resp = (statusCode, obj) => ({ statusCode, body: JSON.stringify(obj) });

export async function handler(event) {
  const orderName = event.pathParameters?.name;
  const routePath = event.rawPath ?? event.requestContext?.http?.path ?? '';
  const decision = routePath.endsWith('/reject') ? 'reject' : 'approve';

  if (!orderName) return resp(400, { error: 'order name required' });

  const { Item: item } = await ddb.send(
    new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'APPROVAL' } }),
  );
  if (!item?.approvalToken) return resp(404, { error: 'no pending approval', orderName });
  if (item.status !== 'pending') return resp(409, { error: `already ${item.status}`, orderName });

  try {
    if (decision === 'approve') {
      await sfn.send(
        new SendTaskSuccessCommand({
          taskToken: item.approvalToken,
          output: JSON.stringify({ approved: true, orderName }),
        }),
      );
    } else {
      let reason = 'rejected by reviewer';
      try {
        reason = JSON.parse(event.body ?? '{}').reason ?? reason;
      } catch {
        /* keep default reason */
      }
      await sfn.send(
        new SendTaskFailureCommand({ taskToken: item.approvalToken, error: 'ProofRejected', cause: reason }),
      );
    }
  } catch (err) {
    // Token already used or expired (e.g. the workflow timed out).
    console.error('resume failed', orderName, err);
    return resp(410, { error: 'approval token no longer valid', orderName });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { PK: `ORDER#${orderName}`, SK: 'APPROVAL' },
      UpdateExpression: 'SET #s = :s, decidedAt = :d',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': decision === 'approve' ? 'approved' : 'rejected',
        ':d': new Date().toISOString(),
      },
    }),
  );

  return resp(200, { orderName, decision });
}
