// Poller Lambda (Week 5 skeleton).
//
// Runs OUTSIDE the VPC (no NAT needed): polls OrderDesk for the job pool,
// filters/cleans it, then enqueues each cleaned job onto the intake FIFO queue
// and records the order in DynamoDB. Scheduled by EventBridge in Week 10; until
// then it can be invoked manually.
//
// Real OrderDesk logic is filled in once the API credentials are seeded into
// SSM Parameter Store (see src/shared/secrets.mjs / docs/secrets-and-iam.md).

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});
const INTAKE_QUEUE_URL = process.env.INTAKE_QUEUE_URL;
const JOBS_TABLE = process.env.JOBS_TABLE;

/**
 * @returns {Promise<{ polled: number, enqueued: number }>}
 */
export async function handler() {
  // TODO(week6): const od = await getGroup('orderdesk'); poll OrderDesk API.
  const jobs = []; // <- cleaned job pool goes here

  let enqueued = 0;
  for (const job of jobs) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: INTAKE_QUEUE_URL,
        MessageBody: JSON.stringify(job),
        MessageGroupId: 'intake',
        MessageDeduplicationId: String(job.id),
      }),
    );
    enqueued += 1;
  }

  console.log(JSON.stringify({ msg: 'poller run', table: JOBS_TABLE, polled: jobs.length, enqueued }));
  return { polled: jobs.length, enqueued };
}
