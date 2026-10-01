// Customer approval links — the signed token that lets a customer approve their
// own proof without an account.
//
// Why this exists: the proof-ready email points customers at
// proof.stickersbanners.com, and that portal posts the approval to *Linh's*
// program. The day his program is switched off, that path goes dead and every
// order stalls at the proof gate with nobody able to release it. This gives us
// our own path: the mail carries a link that only we can have issued, and
// clicking through resumes our own paused Step Functions execution.
//
// Design constraints (CLAUDE.md, from Linh):
//   - customers APPROVE. There is no reject and no upload — revisions come back
//     by email to sales@. So the token grants exactly one verb.
//   - no accounts: customers never had a login, and inventing one now would
//     strand every existing customer. A signed, expiring, single-order link is
//     the standard way to do that (same shape as an unsubscribe link).
//
// The token is an HMAC over {order, expiry}. It is not secret-bearing (it
// carries no credentials), it cannot be edited (the signature covers the whole
// payload), it names exactly one order, and it dies on its own.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Token version prefix — lets the format change without accepting old shapes. */
const VERSION = 'v1';

/**
 * How long a link stays valid. The workflow's own approval wait is 7 days
 * (workflow-stack `timeout`), so 14 deliberately outlives it: a late click then
 * gets an honest "this order already timed out" from the workflow instead of a
 * confusing "bad link".
 */
export const LINK_TTL_DAYS = 14;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** HMAC-SHA256 of the payload segment, as base64url. */
function sign(payloadSegment, secret) {
  return createHmac('sha256', String(secret)).update(payloadSegment).digest('base64url');
}

/** Constant-time compare that also tolerates different lengths. */
function sameSignature(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Mint an approval token for one order.
 *
 * @param {{ orderName: string, secret: string, ttlDays?: number, now?: number }} p
 * @returns {string} `v1.<payload>.<signature>`
 */
export function signApprovalToken({ orderName, secret, ttlDays = LINK_TTL_DAYS, now = Date.now() }) {
  if (!orderName) throw new Error('orderName is required');
  if (!secret) throw new Error('secret is required');

  const expiresAt = Math.floor(now / 1000) + Math.round(ttlDays * 86400);
  const payload = b64url(JSON.stringify({ o: String(orderName), e: expiresAt }));
  return `${VERSION}.${payload}.${sign(`${VERSION}.${payload}`, secret)}`;
}

/**
 * Check a token and say which order it approves.
 *
 * Never throws — a customer-supplied string is the input, so every failure is a
 * reason, not an exception.
 *
 * @param {{ token: string, secret: string, now?: number }} p
 * @returns {{ ok: true, orderName: string, expiresAt: number }
 *          | { ok: false, reason: 'missing'|'malformed'|'bad-signature'|'expired' }}
 */
export function verifyApprovalToken({ token, secret, now = Date.now() }) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  if (!secret) return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, payload, signature] = parts;

  // Signature first: nothing inside the payload is trustworthy until it passes.
  if (!sameSignature(signature, sign(`${VERSION}.${payload}`, secret))) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const orderName = claims?.o;
  const expiresAt = Number(claims?.e);
  if (!orderName || !Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  if (expiresAt * 1000 <= now) return { ok: false, reason: 'expired' };

  return { ok: true, orderName: String(orderName), expiresAt };
}

/**
 * The URL that goes in the proof-ready email.
 * `portalBase` is whatever page shows the proof and carries the approve button.
 */
export function approvalUrl({ portalBase, token }) {
  const base = String(portalBase).replace(/[?#].*$/, '').replace(/\/+$/, '');
  return `${base}?t=${encodeURIComponent(token)}`;
}
