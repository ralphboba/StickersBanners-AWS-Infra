// Notify-consumer Lambda.
//
// Triggered by messages on the notify FIFO queue. The only customer-facing
// notification is the proof-ready email, sent via Zendesk (our main customer
// channel). Ops chat alerts are intentionally off — staff track everything in
// the dashboard — so other message types are logged and acked with no send.
//
// Returning batchItemFailures lets SQS retry only the messages that failed.

import { sendProofReadyEmail } from '../../shared/zendesk.mjs';
import { signApprovalToken, approvalUrl } from '../../shared/approval-link.mjs';
import { getGroup } from '../../shared/secrets.mjs';

const PROOF_CDN_BASE = process.env.PROOF_CDN_BASE ?? '';
const PROOF_PORTAL_BASE = process.env.PROOF_PORTAL_BASE ?? '';
void PROOF_CDN_BASE; // tiles are loaded by the portal, not linked from the mail

// Safety net: synthetic demo/test orders (DEMO-*, ZZ-*) never send a real
// customer email, regardless of any other flag. Real orders are unaffected.
function isDemoOrder(name) {
  return typeof name === 'string' && /^(DEMO-|ZZ-)/i.test(name);
}

/**
 * The customer link.
 *
 * Two paths, and which one we take is decided entirely by SSM — no deploy:
 *
 *  1. `approval/link-secret` + `approval/portal-base` are seeded -> the mail
 *     carries OUR page with a signed, single-order, expiring token, and the
 *     approval lands in OUR pipeline. This is what has to be in place before
 *     Linh's program can be switched off.
 *  2. They are absent (today) -> we fall back to PROOF_PORTAL_BASE, which is
 *     Linh's portal, exactly as before. Nothing changes while his program is
 *     still the one running.
 *
 * Seeding those two parameters IS the switchover, and clearing them is the
 * rollback. Deliberately not a code flag: it has to be reversible in seconds
 * without a deploy, and a half-issued link must never go out.
 *
 * PROOF_CDN_BASE still serves the DZI tiles the page itself loads.
 */
async function proofUrl(orderName) {
  let group = {};
  try {
    group = await getGroup('approval');
  } catch (err) {
    // SSM unreachable: fall through to the legacy portal rather than fail the
    // email. A customer with the old link is far better off than no mail.
    console.warn('could not read approval settings, using the legacy portal', err);
  }

  const secret = group['link-secret'];
  const portalBase = group['portal-base'];
  if (secret && portalBase) {
    return approvalUrl({ portalBase, token: signApprovalToken({ orderName, secret }) });
  }
  if (secret || portalBase) {
    // Half-configured. Sending an unsigned link to our own page would show the
    // customer a dead button, so stay on the legacy portal and say so loudly.
    console.warn(JSON.stringify({
      msg: 'approval link half-configured, using the legacy portal',
      hasSecret: Boolean(secret), hasPortalBase: Boolean(portalBase),
    }));
  }

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
        // zendesk.mjs decides whether this actually goes out (ZENDESK_SENDS).
        // Either way the pipeline continues to the approval gate, so the rest
        // of the flow is observable with the email held.
        const result = await sendProofReadyEmail({
          orderName: n.orderName,
          customerEmail: n.customerEmail,
          customerName: n.customerName,
          proofUrl: await proofUrl(n.orderName),
        });
        console.log(JSON.stringify({
          msg: result.sent ? 'proof email sent' : `proof email held (${result.skipped})`,
          orderName: n.orderName,
        }));
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
