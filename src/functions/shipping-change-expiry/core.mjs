// Undo a shipping change the customer never paid for.
//
// When a change is requested the customer's Shopify order is edited at once
// and left with a balance. Order Desk is not touched until payment, so the
// factory never sees an unpaid change — but Shopify would show the order as
// part-paid on a faster service for ever. After REVERT_AFTER (48h, set at
// request time) this puts the original shipping line back.
//
// It refuses rather than guess:
//   · already paid (balance cleared) but still pending -> the paid webhook was
//     missed; flag it, write nothing;
//   · the shipping line is no longer the one we added -> someone changed it by
//     hand; flag it;
//   · the staged revert does not clear the balance exactly -> flag it.
// Commits go through SHOPIFY_WRITES like every other Shopify write.

/**
 * @param {{ listPending: () => Promise<object[]>, now: () => number,
 *           loadShopifyOrder: (orderName: string) => Promise<object|null>,
 *           stage: (p: object) => Promise<object>, commit: (p: object) => Promise<object>,
 *           markExpired: (change: object) => Promise<void>,
 *           markAttention: (change: object, reason: string) => Promise<void>,
 *           notify: (orderName: string, text: string) => Promise<object> }} deps
 */
export function makeExpiryJob(deps) {
  return async function run() {
    const results = [];
    for (const change of await deps.listPending()) {
      if (change.status !== 'pending') continue;
      if (Date.parse(change.revertAfter) > deps.now()) continue;
      results.push({ orderName: change.orderName, ref: change.ref, ...(await expire(deps, change)) });
    }
    return results;
  };
}

async function flag(deps, change, reason) {
  await deps.markAttention(change, reason);
  await deps.notify(change.orderName, `${change.orderName} shipping change ${change.ref} could not be undone `
    + `automatically (${reason}). Please check the Shopify order.${change.test ? ' (TEST)' : ''}`);
  return { reverted: false, flagged: reason };
}

async function expire(deps, change) {
  const order = await deps.loadShopifyOrder(change.orderName);
  if (!order) return flag(deps, change, 'order_not_found');
  if (order.outstandingCents !== null && order.outstandingCents <= 0) return flag(deps, change, 'paid_not_processed');

  const line = order.shippingLines.find((l) => l.title === change.to);
  if (!line || order.shippingLines.length !== 1) return flag(deps, change, 'shipping_line_changed');

  const staged = await deps.stage({
    orderId: order.id, removeLineId: line.id,
    title: change.restore.title, priceCents: change.restore.priceCents,
  });
  // Putting the paid line back must leave exactly nothing owed.
  if (!staged.ok || staged.outstandingCents !== 0) return flag(deps, change, staged.ok ? 'revert_leaves_balance' : staged.reason);

  const committed = await deps.commit({
    orderName: change.orderName, calculatedOrderId: staged.calculatedOrderId,
    staffNote: `Shipping change ${change.ref} expired unpaid; restored ${change.restore.title}`,
  });
  if (!committed.committed) return { reverted: false, skipped: committed.skipped ?? committed.error };

  await deps.markExpired(change);
  await deps.notify(change.orderName, `${change.orderName} shipping change ${change.from} → ${change.to} `
    + `expired unpaid — reverted.${change.test ? ' (TEST)' : ''}`);
  return { reverted: true };
}
