// Notify-consumer Lambda.
//
// Triggered by messages on the notify FIFO queue. The only customer-facing
// notification is the proof-ready email, sent via Zendesk (our main customer
// channel). Ops chat alerts are intentionally off — staff track everything in
// the dashboard — so other message types are logged and acked with no send.
//
// Returning batchItemFailures lets SQS retry only the messages that failed.

import { sendProofReadyEmail } from '../../shared/zendesk.mjs';

const PROOF_CDN_BASE = process.env.PROOF_CDN_BASE ?? '';

/** Best-effort proof link for the customer (single-item review image). */
function proofUrl(orderName) {
  if (!PROOF_CDN_BASE) return undefined;
  return `${PROOF_CDN_BASE}/${encodeURIComponent(orderName)}/1-1v1.tif_review.jpg`;
}

/**
 * @param {{ Records: Array<{ messageId: string, body: string }> }} event
 */
export async function handler(event) {
  const failures = [];

  for (const record of event.Records ?? []) {
    let n;
    try {
      n = JSON.parse(record.body);
    } catch (err) {
      console.error('bad notify message', record.messageId, err);
      continue; // unparseable -> drop (retrying won't help)
    }

    try {
      if (n.type === 'proof-ready') {
        await sendProofReadyEmail({
          orderName: n.orderName,
          customerEmail: n.customerEmail,
          customerName: n.customerName,
          proofUrl: proofUrl(n.orderName),
        });
        console.log(JSON.stringify({ msg: 'proof email sent', orderName: n.orderName }));
      } else {
        // order-complete / order-failed etc. — dashboard-only, no external send.
        console.log(JSON.stringify({ msg: 'notify (no-op)', type: n.type, orderName: n.orderName }));
      }
    } catch (err) {
      console.error('notify failed', record.messageId, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}
