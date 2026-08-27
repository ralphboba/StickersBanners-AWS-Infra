// Zendesk — the main channel we use to talk to customers.
//
// When a proof is ready, we create a public ticket with the customer as the
// requester; Zendesk emails them the proof link so they can review and reply
// if they want changes (revisions are handled by staff over email — customers
// never upload files here).

import { getGroup } from './secrets.mjs';

/**
 * Create a "proof ready" ticket that emails the customer.
 * @param {{ orderName: string, customerEmail: string, customerName?: string, proofUrl?: string }} p
 */
export async function sendProofReadyEmail({ orderName, customerEmail, customerName, proofUrl }) {
  if (!customerEmail) throw new Error(`no customer email for order ${orderName}`);
  const g = await getGroup('zendesk');
  const subdomain = g.subdomain;
  const auth = Buffer.from(`${g.email}/token:${g['api-token']}`).toString('base64');

  const hi = customerName ? `Hi ${customerName},` : 'Hi,';
  const link = proofUrl ? `\n\nView your proof here:\n${proofUrl}` : '';
  const body =
    `${hi}\n\nYour proof for order ${orderName} is ready to review.${link}\n\n` +
    `If everything looks good, no action is needed — we'll get it printed. ` +
    `If you'd like any changes, just reply to this email and our team will help.\n\n` +
    `Thanks,\nStickersBanners`;

  const res = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      ticket: {
        subject: `Your proof is ready — Order ${orderName}`,
        requester: { email: customerEmail, name: customerName || customerEmail },
        comment: { public: true, body },
        tags: ['proof_ready', 'auto'],
      },
    }),
  });
  if (!res.ok) throw new Error(`Zendesk ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
