// Google Chat notice for a paid shipping change.
//
// One line into the team's space when a customer's upgrade has been written to
// Order Desk, e.g.
//
//   S64262 upgraded FedEx Ground → FedEx 3-Days · +$17.38 + $1.04 tax
//
// Kai (2026-09-28) asked for this. It is an exception to Linh's "Zendesk only,
// Google Chat off" rule, which is about proof notifications.
//
// Sent only AFTER the Order Desk write has succeeded — a notice about a change
// that did not happen would send someone to look for it. Synthetic orders
// (DEMO-*, ZZ-*) never send.
//
// The webhook URL carries its own key and token, so it is a secret: it comes
// from the caller (SSM in Lambda, an env var in a session) and is never logged.
//
// Facility spaces (Kai, 2026-10-02): every notice goes to the main space; an
// order whose CURRENT Order Desk folder belongs to GA, NJ or TX also goes to
// that facility's space (/sb/<env>/gchat/webhook-url-GA|NJ|TX). A facility
// space that is not set up, or fails, never affects the main notice or the
// Order Desk write.

import { isSyntheticOrder } from './write-gates.mjs';
import { toCents, centsToAmount } from './money.mjs';

/**
 * @param {{ orderName: string, from: string, to: string, amount: number,
 *           tax?: number, test?: boolean, converted?: boolean }} p
 */
export function upgradeMessage({ orderName, from, to, amount, tax = 0, test = false, converted = false }) {
  const a = toCents(amount);
  const t = toCents(tax);
  if (a === null || a <= 0 || t === null || t < 0) throw new Error('amount must be positive, tax non-negative');
  const verb = converted ? 'changed from pickup' : 'upgraded';
  const money = t > 0 ? `+$${centsToAmount(a)} + $${centsToAmount(t)} tax` : `+$${centsToAmount(a)}`;
  return `${orderName} ${verb} ${from} → ${to} · ${money}${test ? ' (TEST)' : ''}`;
}

/** Only an https Google Chat webhook is accepted as a destination. */
export function isChatWebhook(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'chat.googleapis.com'
      && /^\/v1\/spaces\/[^/]+\/messages$/.test(u.pathname)
      && u.searchParams.has('key') && u.searchParams.has('token');
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ sent: boolean, skipped?: string, status?: number }>}
 */
export async function sendChat({ webhookUrl, orderName, text, fetchImpl }) {
  if (isSyntheticOrder(orderName)) return { sent: false, skipped: 'synthetic' };
  if (!webhookUrl) return { sent: false, skipped: 'no_webhook' };
  if (!isChatWebhook(webhookUrl)) return { sent: false, skipped: 'not_a_chat_webhook' };
  const res = await (fetchImpl ?? fetch)(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
  });
  return res.ok ? { sent: true, status: res.status } : { sent: false, skipped: 'http_error', status: res.status };
}

/** Facilities that have their own Chat space. */
export const FACILITY_SPACES = Object.freeze(['GA', 'NJ', 'TX']);

/** SSM key (under gchat/) of the facility's space, or null. */
export function facilitySpaceKey(facility) {
  const f = String(facility ?? '').toUpperCase();
  return FACILITY_SPACES.includes(f) ? `webhook-url-${f}` : null;
}

/**
 * Main space always; the facility's space too when it has one.
 * getUrl(key) returns the webhook URL for gchat/<key> (throws or returns
 * empty when it is not set).
 * @returns {Promise<{ sent: boolean, skipped?: string, status?: number, facility?: object }>}
 */
export async function notifyChat({ getUrl, orderName, text, facility, fetchImpl }) {
  const send = async (key) => {
    let webhookUrl;
    try { webhookUrl = await getUrl(key); } catch { return { sent: false, skipped: 'no_webhook' }; }
    try { return await sendChat({ webhookUrl, orderName, text, fetchImpl }); } catch { return { sent: false, skipped: 'network_error' }; }
  };
  const spaceKey = facilitySpaceKey(facility);
  const [main, extra] = await Promise.all([send('webhook-url'), spaceKey ? send(spaceKey) : null]);
  return extra ? { ...main, facility: { name: String(facility).toUpperCase(), ...extra } } : main;
}
