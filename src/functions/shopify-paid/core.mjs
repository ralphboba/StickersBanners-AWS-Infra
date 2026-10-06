// Shopify payment (orders/paid, orders/updated) -> Order Desk -> Google Chat.
//
// The last step of a self-service shipping change. The customer's order was
// edited (shopify-order-edit.mjs) and left with a balance; this runs when they
// pay it. Pure logic — index.mjs supplies the row store, Order Desk, Chat and
// the webhook secret, and the tests supply fakes.
//
// What makes it safe to run on every paid order in the store:
//   · the Shopify signature is checked before anything is read;
//   · it acts only on an order that has a PENDING change record, written when
//     the edit was committed — every other paid order is ignored;
//   · the folder is re-checked at payment time: paid too late means nothing
//     is written and the team is told a refund is needed;
//   · the Order Desk write is idempotent on the change's reference, so a
//     repeated webhook cannot add the money twice (tested live on S64262);
//   · Chat hears only about a write that actually happened.
// Order Desk write itself stays behind ORDERDESK_UPGRADE_WRITES
// (applyShippingUpgrade).

import crypto from 'node:crypto';

import { upgradeMessage } from '../../shared/gchat.mjs';
import { centsToDollars, toCents } from '../../shared/money.mjs';

/**
 * Topics this handler acts on. orders/paid is the obvious one, but Shopify does
 * not send it when the balance of an order that was ever partly refunded is
 * paid: such an order stays "partially_refunded". orders/updated arrives for
 * every payment, so both are subscribed and the money decides, not the topic.
 */
export const PAID_TOPICS = new Set(['orders/paid', 'orders/updated']);

/**
 * Is nothing left to pay? The webhook body is the REST order: total_outstanding
 * is the balance. A payload without it falls back to financial_status.
 */
export function fullyPaid(order) {
  const status = String(order?.financial_status ?? '');
  if (!['paid', 'partially_refunded'].includes(status)) return false;
  if (order?.total_outstanding === undefined || order?.total_outstanding === null) return status === 'paid';
  return toCents(String(order.total_outstanding)) === 0;
}

/** Shopify signs the raw body with the app's webhook secret (base64 HMAC-SHA256). */
export function verifyShopifyHmac(rawBody, headerHmac, secret) {
  if (!rawBody || !headerHmac || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  let given;
  try { given = Buffer.from(String(headerHmac), 'base64'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const header = (event, name) => {
  const h = event?.headers ?? {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
};
const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

/**
 * @param {{ webhookSecret: () => Promise<string>,
 *           loadPending: (orderName: string) => Promise<object|null>,
 *           markDone: (orderName: string, ref: string, result: object, change: object) => Promise<void>,
 *           markAttention: (orderName: string, ref: string, reason: string) => Promise<void>,
 *           stillAllowed: (change: object) => Promise<{ allowed: boolean, reason?: string, label?: string }>,
 *           applyOrderDesk: (change: object) => Promise<object>,
 *           notify: (orderName: string, text: string, where?: { facility?: string|null }) => Promise<object> }} deps
 *
 * stillAllowed may also return `facility` (GA/NJ/TX/...) from the order's
 * current Order Desk folder; notify uses it to pick the facility's Chat space.
 */
export function makePaidHandler(deps) {
  return async function handler(event = {}) {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    if (!verifyShopifyHmac(raw, header(event, 'X-Shopify-Hmac-Sha256'), await deps.webhookSecret())) {
      return reply(401, { error: 'bad_signature' });
    }
    if (!PAID_TOPICS.has(header(event, 'X-Shopify-Topic'))) return reply(200, { ignored: 'topic' });

    let order;
    try { order = JSON.parse(raw); } catch { return reply(400, { error: 'bad_json' }); }
    const orderName = String(order?.name ?? '').replace(/^#/, '');
    if (!orderName) return reply(200, { ignored: 'no_name' });
    if (!fullyPaid(order)) return reply(200, { ignored: 'not_paid' });

    const change = await deps.loadPending(orderName);
    if (!change) return reply(200, { ignored: 'no_pending_change' });
    if (change.status === 'done') return reply(200, { ignored: 'already_done', ref: change.ref });
    if (change.status === 'attention') return reply(200, { ignored: 'already_flagged', ref: change.ref });
    // Only an unpaid choice is payable: a record retired by a switch or a
    // failed commit ('replaced', 'failed') never writes Order Desk.
    if (change.status !== 'pending') return reply(200, { ignored: 'not_pending', ref: change.ref, status: change.status });

    // The edit must actually be on the order. A record is saved just BEFORE
    // the commit, so for a second it exists while the order is still fully
    // paid at its old shipping — an unrelated orders/updated in that second
    // (the pickup address being set, a staff edit) must not be taken for the
    // payment.
    if (Array.isArray(order.shipping_lines)
      && !order.shipping_lines.some((l) => String(l?.title ?? '') === change.to)) {
      return reply(200, { ignored: 'edit_not_on_order', ref: change.ref });
    }

    const r = await settleChange(deps, orderName, change);
    // Another settler (the other topic's webhook, or the reconciler) has it.
    if (r.reason === 'in_progress') return reply(200, { ignored: 'in_progress', ref: change.ref });
    if (r.reason === 'too_late') return reply(200, { written: false, reason: 'too_late', detail: r.detail });
    if (!r.written && !r.duplicate) {
      // Not written (switch off, or Order Desk failed). A 500 makes Shopify
      // retry; the reference keeps the retry from doubling anything — and the
      // reconciler (shipping-change-reconcile) retries too, whatever Shopify does.
      return reply(r.reason === 'disabled' || r.reason === 'synthetic' ? 200 : 500, { written: false, reason: r.reason });
    }
    return reply(200, { written: r.written, duplicate: r.duplicate, chat: r.chat });
  };
}

/**
 * Apply a PAID change: re-check the folder, write Order Desk, mark the record,
 * tell Chat. Shared by the payment webhook and the reconciler, so a payment is
 * handled the same way whichever of them sees it first; the Order Desk write is
 * idempotent on change.ref, so both seeing it is harmless.
 *
 * @returns {Promise<{ written: boolean, duplicate?: boolean, chat?: boolean,
 *                     reason?: string, detail?: string }>}
 */
export async function settleChange(deps, orderName, change) {
  if (deps.claim && !(await deps.claim(orderName, change.ref))) return { written: false, reason: 'in_progress' };
  try {
    return await settle(deps, orderName, change);
  } finally {
    // Done and attention clear the claim themselves; anything else (not
    // written, or thrown) frees it for the next try.
    if (deps.release) await deps.release(orderName, change.ref);
  }
}

async function settle(deps, orderName, change) {
    // ── paid too late? ─────────────────────────────────────────────────
    // The quote was right when it was given; the customer may pay days later.
    // By then the order may have gone to Awaiting Shipment (Ground can no
    // longer change) or Completed. Re-decide from Order Desk NOW; if the change
    // is no longer allowed, write nothing and tell the team — the customer has
    // paid for something we cannot do, and that needs a person and a refund.
    const late = await deps.stillAllowed(change);
    const where = { facility: late.facility ?? null };
    if (!late.allowed) {
      await deps.markAttention(orderName, change.ref, late.reason);
      await deps.notify(orderName, `${orderName} PAID for ${change.from} → ${change.to} `
        + `(+$${centsToDollars((change.shippingCents ?? 0) + (change.taxCents ?? 0)).toFixed(2)}) but the order is now `
        + `${late.label ?? 'past the point of change'} — NOT applied. Refund or handle by hand.`
        + (change.test ? ' (TEST)' : ''), where);
      return { written: false, reason: 'too_late', detail: late.reason };
    }

    const result = await deps.applyOrderDesk(change);
    if (!result.applied && result.skipped !== 'duplicate') {
      console.log(JSON.stringify({ msg: 'paid change not written', orderName, ref: change.ref, result }));
      return { written: false, reason: result.skipped ?? result.error };
    }

    await deps.markDone(orderName, change.ref, result, change);

    // Only a write that happened now is announced; a duplicate was announced
    // the first time.
    let chat = { sent: false, skipped: 'duplicate' };
    if (result.applied) {
      chat = await deps.notify(orderName, upgradeMessage({
        orderName, from: result.from ?? change.from, to: change.to,
        amount: centsToDollars(change.shippingCents), tax: centsToDollars(change.taxCents ?? 0),
        converted: Boolean(result.converted), test: Boolean(change.test),
      }), where);
    }
    return { written: Boolean(result.applied), duplicate: result.skipped === 'duplicate', chat: Boolean(chat.sent) };
}
