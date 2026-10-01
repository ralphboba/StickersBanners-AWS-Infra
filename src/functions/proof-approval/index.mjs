// Customer proof approval — the public half of the proof gate.
//
// ⚠️  This is the only route in the system a member of the public can reach
//     that changes an order's state. Keep its surface exactly this small.
//
// Background: today the proof-ready email sends customers to
// proof.stickersbanners.com, which posts the approval to Linh's program. Ours
// never hears about it, so the moment his program is switched off every order
// would sit at the proof gate until the workflow's 7-day timeout killed it.
// This is the customer's way into OUR pipeline.
//
// All of the decision logic — and the reasoning about what is deliberately NOT
// here — lives in core.mjs, which is unit-tested. This file is only the AWS
// plumbing behind its four ports.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

import { makeProofApprovalHandler } from './core.mjs';
import { getSecret } from '../../shared/secrets.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const JOBS_TABLE = process.env.JOBS_TABLE;

export const handler = makeProofApprovalHandler({
  /** CloudFront base serving the DZI tiles + derivative jpgs the page renders. */
  proofCdnBase: process.env.PROOF_CDN_BASE ?? '',

  loadSecret: async () => {
    try {
      return await getSecret('approval', 'link-secret');
    } catch (err) {
      // Not seeded (or SSM is down). core.mjs turns this into a 503; it must
      // never be read as "no signature required".
      console.error('could not read the approval link secret', err);
      return '';
    }
  },

  loadOrder: async (orderName) => {
    const [meta, approval] = await Promise.all([
      ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'META' } })),
      ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { PK: `ORDER#${orderName}`, SK: 'APPROVAL' } })),
    ]);
    return { meta: meta?.Item, approval: approval?.Item };
  },

  // SendTaskSuccess only. The role has no states:SendTaskFailure, so even a bug
  // here cannot reject a customer's order.
  resumeWorkflow: ({ taskToken, orderName }) => sfn.send(new SendTaskSuccessCommand({
    taskToken,
    output: JSON.stringify({ approved: true, orderName, approvedBy: 'customer' }),
  })),

  recordApproved: (orderName, at) => ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { PK: `ORDER#${orderName}`, SK: 'APPROVAL' },
    UpdateExpression: 'SET #s = :s, decidedAt = :d, decidedBy = :who',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': 'approved', ':d': at, ':who': 'customer' },
  })),
});
