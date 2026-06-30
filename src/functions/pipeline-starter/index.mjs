// Pipeline starter (Week 7).
//
// Triggered by intake.fifo messages; starts one Step Functions execution per
// cleaned job. Kept as a tiny adapter (SQS -> StartExecution) so the workflow
// itself stays declarative. (EventBridge Pipes is the no-code alternative; we
// use a Lambda for reliable JSON-body handling.)

import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

/** Execution names: alphanumeric/-/_ only, <= 80 chars. */
function execName(orderName, messageId) {
  return `${orderName ?? 'order'}-${messageId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

export async function handler(event) {
  const failures = [];
  for (const record of event.Records ?? []) {
    try {
      const job = JSON.parse(record.body);
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          name: execName(job.orderName, record.messageId),
          input: JSON.stringify(job),
        }),
      );
    } catch (err) {
      console.error('start failed', record.messageId, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
