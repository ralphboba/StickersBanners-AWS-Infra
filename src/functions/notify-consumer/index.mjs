// Notify-consumer Lambda (Week 5 skeleton).
//
// Triggered by messages on the notify FIFO queue. Sends Discord / email
// notifications. Credentials (Discord webhook, Gmail app password) come from
// SSM Parameter Store at runtime.
//
// Returning batchItemFailures lets SQS retry only the messages that failed
// (partial-batch response) rather than the whole batch.

/**
 * @param {{ Records: Array<{ messageId: string, body: string }> }} event
 */
export async function handler(event) {
  const failures = [];

  for (const record of event.Records ?? []) {
    try {
      const notification = JSON.parse(record.body);
      // TODO(week6): const { 'webhook-url': url } = await getGroup('discord');
      // await fetch(url, { method: 'POST', body: ... });
      console.log(JSON.stringify({ msg: 'notify', type: notification.type ?? 'unknown' }));
    } catch (err) {
      console.error('notify failed', record.messageId, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
