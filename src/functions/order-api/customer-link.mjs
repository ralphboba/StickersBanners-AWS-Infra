// The customer's approval page link, for staff to open from the dashboard.
//
// It is the same signed link the proof-ready email carries (notify-consumer
// proofUrl), minted on demand so staff can see exactly what the customer sees
// without waiting for — or digging up — the composed email.

import { signApprovalToken, approvalUrl } from '../../shared/approval-link.mjs';

/**
 * The link for one order, or undefined when there is none to give.
 *
 * Only an order waiting at OUR proof gate has one: a mirror row is Linh's
 * program's order (it has no proof from this system), and DEMO / ZZ orders
 * never go through proof. Both approval settings must be seeded — the same
 * rule the email follows, so this never shows a link the email would not send.
 *
 * @param {object} meta the order's META record
 * @param {{ 'link-secret'?: string, 'portal-base'?: string }} approval SSM group
 */
export function customerProofLink(meta, approval, now = Date.now()) {
  if (!meta || meta.status !== 'proofing' || meta.mirror) return undefined;
  if (/^(DEMO|ZZ)-/i.test(String(meta.orderName ?? ''))) return undefined;
  const secret = approval?.['link-secret'];
  const portalBase = approval?.['portal-base'];
  if (!secret || !portalBase) return undefined;
  return approvalUrl({ portalBase, token: signApprovalToken({ orderName: meta.orderName, secret, now }) });
}
