// Request-approval (Week 8).
//
// Invoked by Step Functions with the WAIT_FOR_TASK_TOKEN pattern at the proof
// review gate. It persists the task token against the order so the out-of-band
// approval API can resume the workflow later, then returns — the workflow stays
// paused until SendTaskSuccess/Failure is called with this token.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;

/**
 * @param {{ taskToken: string, orderName: string }} event
 */
export async function handler(event) {
  const { taskToken, orderName } = event;
  if (!taskToken || !orderName) {
    throw new Error('taskToken and orderName are required');
  }

  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { PK: `ORDER#${orderName}`, SK: 'APPROVAL' },
      UpdateExpression: 'SET approvalToken = :t, #s = :s, requestedAt = :r',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':t': taskToken,
        ':s': 'pending',
        ':r': new Date().toISOString(),
      },
    }),
  );

  console.log(JSON.stringify({ msg: 'approval pending', orderName }));
  return { stored: true }; // workflow remains paused (waitForTaskToken)
}
