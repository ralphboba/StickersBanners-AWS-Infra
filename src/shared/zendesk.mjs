// Zendesk — the only external notification the system sends.
//
// Ported from legacy zendeskHelper.submitTicket. When a proof is ready we open a
// ticket with the customer as requester; Zendesk emails them the proof link.
//
// Linh's rules, confirmed:
//   - the customer DOES approve, on the proof portal. What he didn't want was a
//     *disapprove* button, and customers uploading replacement files.
//   - revisions come back by email to sales@stickersbanners.com, not through
//     the portal.
// So the mail says "view and approve", and offers no upload path.
//
// ⚠️  THIS IS THE ONLY CODE THAT CONTACTS A REAL CUSTOMER. ⚠️
//
// Held behind ZENDESK_SENDS, the same shape as ORDERDESK_WRITES: the ticket is
// composed in full, logged, and returned, but the HTTP POST does not happen
// unless ZENDESK_SENDS is explicitly "enabled". That is what makes it safe to
// run real orders through the whole pipeline — intake, resize, finish, proof —
// and see exactly what each customer WOULD have received, without anyone's
// inbox being touched. Arming it is a go-live action needing Kai's explicit
// approval (see CLAUDE.md "Safety").

import { getGroup } from './secrets.mjs';

const PROOF_VIEWER_URL = 'https://proof.stickersbanners.com/proof-viewer';
const SALES_EMAIL = 'sales@stickersbanners.com';

/** Synthetic orders never email anyone, whatever the flag says. */
function isSyntheticOrder(name) {
  return /^(DEMO-|ZZ-)/i.test(String(name ?? ''));
}

/**
 * Is the real customer email switched on? Defaults to OFF.
 * Deliberately an exact match on "enabled" so a stray truthy value (e.g. "0",
 * "false", "no") cannot arm it by accident — same rule as ORDERDESK_WRITES.
 */
export function zendeskSendsEnabled() {
  return String(process.env.ZENDESK_SENDS ?? '').trim().toLowerCase() === 'enabled';
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Legacy emailTemplate.html, with ${orderId} substituted. Kept close to the
 * original wording — customers have been reading this exact mail for a while,
 * and the desktop/zoom advice matters for judging a proof.
 */
export function proofEmailHtml(orderName, proofUrl = PROOF_VIEWER_URL) {
  return [
    '<p>Hello,<br />',
    `Your proof for order <strong>${esc(orderName)}</strong> is ready for review.<br />`,
    'For best results, please view it on a desktop or larger screen. ',
    'Mobile viewing is supported, but quality may not display accurately. ',
    'Zoom in to check all details before approving.<br />',
    'View and approve your proof here:<br /><br />',
    `<a href="${esc(proofUrl)}" target="_blank" rel="noopener nofollow noreferrer">${esc(proofUrl)}</a><br />`,
    'If you need any changes (file updates, product changes, etc.), please email ',
    `<strong>${SALES_EMAIL}</strong> or reply-all so we receive your request.<br />`,
    'Please note: All proofs must be approved together, and the order will be ',
    'processed as approved.<br />',
    'Best regards,<br /><br /><strong>StickersBanners Team</strong></p>',
  ].join('');
}

/**
 * Create the "proof ready" ticket. Mirrors legacy submitTicket: the customer is
 * the requester and is CC'd, the ticket is assigned to the proofing agent, left
 * in `pending` (waiting on the customer), and tagged with the order number in
 * the custom field so it can be found by order.
 *
 * @param {{ orderName: string, customerEmail: string, customerName?: string,
 *           proofUrl?: string }} p
 */
export async function sendProofReadyEmail({ orderName, customerEmail, customerName, proofUrl }) {
  if (!customerEmail) throw new Error(`no customer email for order ${orderName}`);

  // Composed before the gate, so the held path reports the real thing — the
  // actual subject, the actual body, the actual signed approval link — and not
  // a summary of what it might have been.
  const subject = `Proof for Order ${orderName} is ready to be reviewed`;
  const htmlBody = proofEmailHtml(orderName, proofUrl || PROOF_VIEWER_URL);
  const preview = { to: customerEmail, subject, proofUrl: proofUrl || PROOF_VIEWER_URL };

  if (isSyntheticOrder(orderName)) {
    console.log(JSON.stringify({ msg: 'proof email skipped (synthetic order)', orderName, ...preview }));
    return { sent: false, skipped: 'synthetic', preview };
  }

  if (!zendeskSendsEnabled()) {
    // The prototype path: say exactly who would have been emailed and with
    // what, contact nobody, and read no credentials.
    console.log(JSON.stringify({
      msg: 'proof email WOULD HAVE BEEN SENT (ZENDESK_SENDS disabled)',
      orderName, ...preview, htmlBody,
    }));
    return { sent: false, skipped: 'disabled', preview };
  }

  const g = await getGroup('zendesk');
  const auth = Buffer.from(`${g.email}/token:${g['api-token']}`).toString('base64');

  const assigneeId = Number(g['assignee-id']);
  const fieldId = Number(g['field-id']);

  const ticket = {
    subject,
    comment: { html_body: htmlBody },
    requester: { name: customerName || 'Customer', email: customerEmail },
    email_ccs: [{ user_email: customerEmail }],
    status: 'pending',
    // Both are optional on our side: if a value is missing from SSM the ticket
    // still goes out, just unassigned / unfiled, rather than failing the send.
    ...(Number.isFinite(assigneeId) && assigneeId > 0 ? { assignee_id: assigneeId } : {}),
    ...(Number.isFinite(fieldId) && fieldId > 0
      ? { custom_fields: [{ id: fieldId, value: orderName }] }
      : {}),
  };

  const res = await fetch(`https://${g.subdomain}.zendesk.com/api/v2/tickets.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ticket }),
  });
  if (!res.ok) throw new Error(`Zendesk ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(JSON.stringify({ msg: 'proof email sent', orderName, ...preview }));
  return { sent: true, preview, ticket: await res.json() };
}
