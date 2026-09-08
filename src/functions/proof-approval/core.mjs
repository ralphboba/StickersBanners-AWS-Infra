// Customer proof approval — the decision logic, with no AWS in it.
//
// Split from index.mjs so this whole path is testable: it is the one place a
// member of the public can change an order's state, and "it looked right" is
// not good enough for that. index.mjs supplies the four ports below; every
// branch here is exercised in test/shared/proof-approval.test.mjs.
//
// What it exposes, and nothing else:
//   GET  /proof?t=<token>   what the customer is approving
//   POST /proof/approve     resume the paused execution — approve ONLY
//
// Deliberately absent, per Linh (CLAUDE.md non-negotiables):
//   - no reject. "i said i didn't see the point in disapproving." The
//     staff-only /orders/{name}/reject stays behind Cognito where it is.
//   - no upload. Customers abused it with 5-6 re-proof files; revisions come
//     back by email to sales@.

import { verifyApprovalToken } from '../../shared/approval-link.mjs';

const SALES_EMAIL = 'sales@stickersbanners.com';

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(obj),
});

/** Why a link was refused, in words a customer can act on. */
const LINK_ERRORS = {
  missing: [400, 'This link is incomplete. Please use the button in your proof email.'],
  malformed: [400, 'This link is not valid. Please use the button in your proof email.'],
  'bad-signature': [403, 'This link is not valid. Please use the button in your proof email.'],
  expired: [410, `This approval link has expired. Please email ${SALES_EMAIL} and we will resend it.`],
};

/** The token, from the query string (GET) or the JSON body (POST). */
export function readToken(event) {
  const fromQuery = event?.queryStringParameters?.t;
  if (fromQuery) return fromQuery;
  try {
    return JSON.parse(event?.body ?? '{}')?.token ?? '';
  } catch {
    return '';
  }
}

/**
 * The proof files the proof service wrote for this order.
 * src/services/proof/main.py names each item `{itemNo}-1v1.tif`, and dzi.py
 * writes `<name>.dzi` plus `<name>_review.jpg` / `_thumbnail.jpg` under
 * `dzi/{order}/`. Rebuilt from the item list rather than stored, so it cannot
 * drift out of sync with a row written weeks earlier.
 */
export function proofFiles(orderName, items, cdnBase) {
  if (!cdnBase) return [];
  const base = String(cdnBase).replace(/\/+$/, '');
  return (items ?? []).map((it, i) => {
    const itemNo = it?.itemNo ?? i + 1;
    const prefix = `${base}/${encodeURIComponent(orderName)}/${encodeURIComponent(`${itemNo}-1v1.tif`)}`;
    return {
      itemNo,
      name: it?.name ?? '',
      review: `${prefix}_review.jpg`,
      thumbnail: `${prefix}_thumbnail.jpg`,
      dzi: `${prefix}.dzi`,
    };
  });
}

/**
 * Build the handler over four narrow ports.
 *
 * @param {{
 *   loadSecret: () => Promise<string>,
 *   loadOrder: (orderName: string) => Promise<{ meta?: object, approval?: object }>,
 *   resumeWorkflow: (p: { taskToken: string, orderName: string }) => Promise<void>,
 *   recordApproved: (orderName: string, at: string) => Promise<void>,
 *   proofCdnBase?: string,
 *   now?: () => number,
 * }} ports
 */
export function makeProofApprovalHandler({
  loadSecret, loadOrder, resumeWorkflow, recordApproved, proofCdnBase = '', now = () => Date.now(),
}) {
  return async function handler(event) {
    const path = event?.rawPath ?? event?.requestContext?.http?.path ?? '';
    const method = event?.requestContext?.http?.method ?? 'GET';
    const isApprove = method === 'POST' && path.endsWith('/approve');

    const secret = await loadSecret();
    if (!secret) {
      // Not seeded yet. Refuse rather than fall back to an unsigned path — "no
      // link secret" must never quietly mean "anyone may approve anything".
      console.error('approval link secret is not configured');
      return json(503, { error: `Approvals are not available yet. Please contact ${SALES_EMAIL}.` });
    }

    const check = verifyApprovalToken({ token: readToken(event), secret, now: now() });
    if (!check.ok) {
      const [status, message] = LINK_ERRORS[check.reason] ?? LINK_ERRORS.malformed;
      console.warn(JSON.stringify({ msg: 'approval link refused', reason: check.reason }));
      return json(status, { error: message, reason: check.reason });
    }

    // The order name comes only from inside a token we minted, never from the
    // request — so no customer can reach another customer's order.
    const { orderName } = check;
    const { meta, approval } = await loadOrder(orderName);
    if (!meta) return json(404, { error: 'We could not find that order.', orderName });

    // The customer's view of their own order. Deliberately narrow: no address,
    // no pricing, no internal routing — just what they are asked to approve.
    // Proof links get forwarded.
    const view = {
      orderName,
      status: approval?.status ?? (meta.status === 'proofing' ? 'preparing' : 'none'),
      proofs: proofFiles(orderName, meta.items, proofCdnBase),
    };

    if (!isApprove) return json(200, view);

    // --- approve -----------------------------------------------------------
    if (approval?.status === 'approved') {
      // Customers double-click, and forwarded mail gets clicked twice. "Already
      // approved" is the truth, and is not an error.
      return json(200, { ...view, status: 'approved', alreadyApproved: true });
    }
    if (!approval?.approvalToken || approval.status !== 'pending') {
      return json(409, {
        ...view,
        error: `This order is not waiting for approval. Please contact ${SALES_EMAIL}.`,
      });
    }

    try {
      await resumeWorkflow({ taskToken: approval.approvalToken, orderName });
    } catch (err) {
      // The workflow already moved on — most often it hit the 7-day timeout.
      console.error('customer approval could not resume the workflow', orderName, err);
      return json(410, {
        ...view,
        error: `This proof can no longer be approved online. Please email ${SALES_EMAIL}.`,
      });
    }

    await recordApproved(orderName, new Date(now()).toISOString());
    console.log(JSON.stringify({ msg: 'proof approved by customer', orderName }));
    return json(200, { ...view, status: 'approved' });
  };
}
