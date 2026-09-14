// Proving that whoever opened the page is the person who placed the order.
//
// There is no login. The link in the confirmation email carries Shopify's own
// order-status URL, which contains an unguessable token Shopify issues per
// order — the same secret that already protects the order status page. We
// compare it against the one captured when the order came in.
//
// The plan originally called for our own HMAC link. Liquid cannot compute an
// HMAC, so the email could not have built one. Reusing Shopify's token needs no
// new secret and no new key rotation (docs/shopify-email-button.md).
//
// ── what this deliberately does not accept ─────────────────────────────────
// The order NAME alone is never enough. S59131, S59132, S59133 — order numbers
// are sequential, so anyone could walk them. The name identifies; the token
// authorises.

import { timingSafeEqual } from 'node:crypto';

/**
 * Domains an order-status URL may legitimately live on. Matched as the exact
 * host or a subdomain of it — never as a bare string suffix, because
 * "notshopify.com".endsWith("shopify.com") is true and so is
 * "myshopify.com.evil.com".endsWith(...) for a carelessly chosen suffix.
 */
const ALLOWED_DOMAINS = ['myshopify.com', 'shopify.com', 'shop.app'];

/**
 * Pull the opaque token out of a Shopify order-status URL.
 *
 * Shopify has used several shapes over the years — with and without a store
 * number, with and without /authenticate, with the key in the query. All of
 * them put the token in the path segment straight after /orders/, so that is
 * what we read rather than matching a whole URL pattern that will change again.
 *
 * @param {string} rawUrl
 * @returns {{ token: string, key: string|null } | null} null if unusable
 */
export function parseOrderStatusUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  const allowed = ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  if (!allowed) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('orders');
  if (at === -1) return null;

  const token = parts[at + 1];
  // Shopify's tokens are long hex-ish strings. Anything short is not one, and
  // letting a one-character "token" through would make the compare meaningless.
  if (!token || token.length < 16 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;

  return { token, key: url.searchParams.get('key') };
}

/** Compare two secrets without leaking their contents through timing. */
export function secretsMatch(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Compare against a same-length buffer and fold the result in.
  if (x.length === 0 || y.length === 0) return false;
  const sameLength = x.length === y.length;
  const padded = sameLength ? y : Buffer.alloc(x.length);
  return timingSafeEqual(x, padded) && sameLength;
}

/**
 * Does this link authorise access to this order?
 *
 * @param {string} presentedUrl  the `s` parameter from the email link
 * @param {string} storedUrl     the order_status_url captured at intake
 */
export function authorisesOrder(presentedUrl, storedUrl) {
  const presented = parseOrderStatusUrl(presentedUrl);
  const stored = parseOrderStatusUrl(storedUrl);
  if (!presented || !stored) return false;
  if (!secretsMatch(presented.token, stored.token)) return false;
  // When the stored URL carries a key, the presented one must carry the same.
  // When it does not, we do not start demanding one.
  if (stored.key !== null && !secretsMatch(presented.key, stored.key)) return false;
  return true;
}
