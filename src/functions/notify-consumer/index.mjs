// Notify-consumer Lambda.
//
// Triggered by messages on the notify FIFO queue. Posts each notification to
// Google Chat via an incoming-webhook URL stored in SSM Parameter Store
// (/sb/<env>/googlechat/webhook-url). Message types come from the workflow:
//   proof-ready    — a proof is ready for review
//   order-complete — files delivered to the facility
//   order-failed   — the pipeline failed
//
// Returning batchItemFailures lets SQS retry only the messages that failed
// (partial-batch response) rather than the whole batch.

import { getSecret } from '../../shared/secrets.mjs';

/** Build the Google Chat message text for a notification. */
function messageFor(n) {
  const order = n.orderName ? `*${n.orderName}*` : 'An order';
  switch (n.type) {
    case 'proof-ready':
      return `🖼️ ${order} — proof is ready for review. Open the dashboard to approve or reject.`;
    case 'order-complete':
      return `✅ ${order} — files delivered to the facility${n.facility ? ` (${n.facility})` : ''}.`;
    case 'order-failed':
      return `⚠️ ${order} — pipeline *failed*${n.error ? `: ${n.error}` : ''}. Needs a look.`;
    default:
      return `ℹ️ ${order} — ${n.type ?? 'update'}.`;
  }
}

let cachedUrl;
async function chatWebhookUrl() {
  if (cachedUrl === undefined) cachedUrl = await getSecret('googlechat', 'webhook-url');
  return cachedUrl;
}

/**
 * @param {{ Records: Array<{ messageId: string, body: string }> }} event
 */
export async function handler(event) {
  const failures = [];
  let url;
  try {
    url = await chatWebhookUrl();
  } catch (err) {
    // No webhook configured yet -> log and ack (don't wedge the queue on retries).
    console.error('googlechat webhook not configured', err);
    return { batchItemFailures: [] };
  }

  for (const record of event.Records ?? []) {
    try {
      const notification = JSON.parse(record.body);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text: messageFor(notification) }),
      });
      if (!res.ok) throw new Error(`Google Chat responded ${res.status}`);
      console.log(JSON.stringify({ msg: 'notified', type: notification.type, orderName: notification.orderName }));
    } catch (err) {
      console.error('notify failed', record.messageId, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
