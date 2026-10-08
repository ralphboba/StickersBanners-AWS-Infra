// Making sure every paid shipping change reaches Order Desk.
//
// The payment webhook is the fast path, but it is only one delivery: if Order
// Desk is down when it arrives, if Shopify gives up retrying, or if Shopify
// drops the subscription after repeated failures, the customer has paid and
// nothing would ever write it. This runs every few minutes, asks Shopify
// directly which open changes are paid, and settles them through the same code
// the webhook uses (shopify-paid/core.mjs settleChange) — so a payment is
// applied whichever of the two sees it first, and only once.
//
// What it will not do on its own is stay quiet: a paid change still not in
// Order Desk after ALERT_AFTER_MS, or a change flagged for a person that nobody
// was told about, is posted to the team's Chat space, once.

import { settleChange } from '../shopify-paid/core.mjs';
import { centsToDollars } from '../../shared/money.mjs';
import { isSyntheticOrder } from '../../shared/write-gates.mjs';

export const ALERT_AFTER_MS = 30 * 60 * 1000;
/** A record saved for a commit that is still running (or died mid-way). */
const IN_FLIGHT_MS = 10 * 60 * 1000;

const total = (c) => `$${centsToDollars((c.shippingCents ?? 0) + (c.taxCents ?? 0)).toFixed(2)}`;

/**
 * Is the change's edit on the order, and the balance paid?
 * @param {{ outstandingCents: number|null, shippingLines?: {title: string}[] }|null} order
 */
export function paidWithChange(order, change) {
  if (!order || order.outstandingCents !== 0) return false;
  if (!(order.shippingLines ?? []).some((l) => l?.title === change.to)) return false;
  // Add-ons: the lines that commit created are on the order.
  if (change.addOns?.length) {
    const ids = new Set(order.lineItemIds ?? []);
    return (change.addedLineItemIds ?? []).length > 0 && change.addedLineItemIds.every((id) => ids.has(id));
  }
  return true;
}

/**
 * @param {{ listOpen: () => Promise<object[]>,
 *           shopifyOrder: (orderName: string) => Promise<object|null>,
 *           markPaidSeen: (orderName: string, ref: string, at: number) => Promise<void>,
 *           markAlerted: (orderName: string, ref: string, at: number) => Promise<void>,
 *           alert: (orderName: string, text: string) => Promise<object>,
 *           now?: () => number } & object} deps  plus everything settleChange needs
 */
export function makeReconciler(deps) {
  const now = deps.now ?? Date.now;
  return async function reconcile() {
    const summary = { open: 0, paid: 0, written: 0, alerted: 0, errors: 0 };
    for (const change of await deps.listOpen()) {
      const name = change.orderName;
      if (!name || isSyntheticOrder(name)) continue;
      summary.open += 1;
      try {
        if (change.status === 'attention') {
          // Flagged for a person (e.g. Shopify's committed balance differed
          // from the quote). A too-late payment was already announced when it
          // was flagged; anything else is told here, once.
          if (!change.alertedAt) {
            const a = await deps.alert(name, `⚠️ ${name} shipping change ${change.from} → ${change.to} (${total(change)}) needs a person: `
              + `${change.attentionReason ?? 'flagged'}. Not applied to Order Desk.${change.test ? ' (TEST)' : ''}`);
            // Marked only once it reached Chat; a failed post is tried again next run.
            if (a?.sent) { await deps.markAlerted(name, change.ref, now()); summary.alerted += 1; }
          }
          continue;
        }
        if (change.status !== 'pending') continue;
        // Saved for a commit that is still running: leave it to that request.
        if (!change.confirmed && now() - Date.parse(change.committedAt ?? 0) < IN_FLIGHT_MS) continue;

        const order = await deps.shopifyOrder(name);
        if (!paidWithChange(order, change)) continue;
        summary.paid += 1;

        const seenAt = change.paidSeenAt ? Date.parse(change.paidSeenAt) : now();
        if (!change.paidSeenAt) await deps.markPaidSeen(name, change.ref, seenAt);

        const r = await settleChange(deps, name, change);
        if (r.written) summary.written += 1;
        if (r.written || r.duplicate || r.reason === 'too_late' || r.reason === 'in_progress') continue;

        console.warn(JSON.stringify({ msg: 'paid change still not in Order Desk', orderName: name, ref: change.ref, reason: r.reason }));
        if (!change.alertedAt && now() - seenAt >= ALERT_AFTER_MS) {
          const a = await deps.alert(name, `⚠️ ${name} PAID ${total(change)} for ${change.from} → ${change.to}, but Order Desk is still not updated `
            + `after ${Math.round((now() - seenAt) / 60000)} min (${r.reason ?? 'unknown'}). Retrying every 5 min — check it.`
            + (change.test ? ' (TEST)' : ''));
          if (a?.sent) { await deps.markAlerted(name, change.ref, now()); summary.alerted += 1; }
        }
      } catch (err) {
        summary.errors += 1;
        console.error(JSON.stringify({ msg: 'reconcile failed for change', orderName: name, ref: change.ref, err: String(err) }));
      }
    }
    console.log(JSON.stringify({ msg: 'shipping change reconcile', ...summary }));
    return summary;
  };
}
