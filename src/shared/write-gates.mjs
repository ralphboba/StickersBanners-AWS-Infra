// Kill switches for every write that leaves this system.
//
// Three separate switches, because the three writes carry different risk and
// become safe at different times:
//
//   ORDERDESK_WRITES          the intake gate's folder/tag move. Arming this
//                             hands real orders to the pipeline, and parts of
//                             the routing it depends on are still awaiting
//                             Linh's confirmation.
//   ORDERDESK_UPGRADE_WRITES  the customer shipping upgrade's shipping_method
//                             PUT. Only ever runs on an order the customer has
//                             already paid an upgrade for.
//   SHOPIFY_WRITES            invoicing and order editing. This one moves money
//                             on a customer's card.
//
// They were one switch. Splitting them is what lets the upgrade feature go live
// while intake stays held back — see docs/invoice-path.md. Arming any of them
// is a go-live action needing Kai's explicit approval (CLAUDE.md "Safety").
//
// Every switch defaults to OFF and is an exact match on "enabled", so a stray
// truthy value ("0", "false", "no", "true") cannot arm one by accident.
//
// ORDERDESK_UPGRADE_WRITES and SHOPIFY_WRITES have no callers yet. That is
// deliberate: the gate exists before the write does, so the write cannot be
// added without one.

/** Synthetic orders never write anywhere, whatever any flag says. */
export function isSyntheticOrder(name) {
  return /^(DEMO-|ZZ-)/i.test(String(name ?? ''));
}

/** Exact, case-insensitive match on "enabled" after trimming. */
function armed(value) {
  return String(value ?? '').trim().toLowerCase() === 'enabled';
}

/** Intake gate folder/tag move. Defaults to OFF. */
export function orderDeskWritesEnabled() {
  return armed(process.env.ORDERDESK_WRITES);
}

/** Customer shipping upgrade -> OrderDesk shipping_method. Defaults to OFF. */
export function orderDeskUpgradeWritesEnabled() {
  return armed(process.env.ORDERDESK_UPGRADE_WRITES);
}

/** Shopify invoicing / order editing — real money. Defaults to OFF. */
export function shopifyWritesEnabled() {
  return armed(process.env.SHOPIFY_WRITES);
}

/**
 * One decision for "may this write go out?", so every call site refuses for the
 * same reasons in the same order: synthetic orders first, then the switch.
 *
 * @param {string} orderName
 * @param {() => boolean} gate  one of the *Enabled functions above
 * @returns {null | { skipped: 'synthetic' | 'disabled' }} null when allowed
 */
export function blockedReason(orderName, gate) {
  if (isSyntheticOrder(orderName)) return { skipped: 'synthetic' };
  if (!gate()) return { skipped: 'disabled' };
  return null;
}

/** All three states at once, for the dashboard and for log lines. */
export function writeGateStatus() {
  return {
    orderDeskWrites: orderDeskWritesEnabled() ? 'ENABLED' : 'disabled',
    orderDeskUpgradeWrites: orderDeskUpgradeWritesEnabled() ? 'ENABLED' : 'disabled',
    shopifyWrites: shopifyWritesEnabled() ? 'ENABLED' : 'disabled',
  };
}
