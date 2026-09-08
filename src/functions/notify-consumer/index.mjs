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
const PROOF_PORTAL_BASE = process.env.PROOF_PORTAL_BASE ?? '';
void PROOF_CDN_BASE; // tiles are loaded by the portal, not linked from the mail

// Safety net: synthetic demo/test orders (DEMO-*, ZZ-*) never send a real
// customer email, regardless of any other flag. Real orders are unaffected.
function isDemoOrder(name) {
  return typeof name === 'string' && /^(DEMO-|ZZ-)/i.test(name);
}

/**
 * The customer link. Linh confirmed customers review AND approve on the proof
 * portal, so the mail must point there — a bare CDN image gives them nothing to
 * approve. Undefined falls back to the portal root inside zendesk.mjs.
 *
 * PROOF_CDN_BASE still serves the DZI tiles the portal itself loads.
 */
function proofUrl(orderName) {
  if (!PROOF_PORTAL_BASE) return undefined;
  return `${PROOF_PORTAL_BASE}?order=${encodeURIComponent(orderName)}`;
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
      if (n.type === 'proof-ready' && isDemoOrder(n.orderName)) {
        // Demo order: show the flow on the dashboard, but send no real email.
        console.log(JSON.stringify({ msg: 'proof email skipped (demo)', orderName: n.orderName }));
      } else if (n.type === 'proof-ready') {
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
