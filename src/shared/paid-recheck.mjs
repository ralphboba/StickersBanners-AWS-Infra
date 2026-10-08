// At payment time: may this paid change still be written to Order Desk?
//
// The same rules the customer page used (order-stage.mjs), re-applied to the
// order as Order Desk holds it NOW. A change already written (its reference is
// in the notes) is always "allowed", so a repeated webhook reaches the
// duplicate guard instead of raising a false alarm.

import { orderStage, isPickup } from './order-stage.mjs';
import { upgradeAlreadyApplied } from './orderdesk-write.mjs';

/**
 * @param {object} od      the Order Desk order, freshly read
 * @param {{ ref: string, to: string }} change
 * @returns {{ allowed: boolean, reason?: string, label?: string }}
 */
export function stillAllowed(od, change) {
  if (!od) return { allowed: false, reason: 'order_not_found' };
  if (upgradeAlreadyApplied(od, change.ref)) return { allowed: true };
  const stage = orderStage({
    folderId: od.folder_id,
    shippingMethod: od.shipping_method,
    shipping: { street: od.shipping?.address1, street2: od.shipping?.address2,
      state: od.shipping?.state, country: od.shipping?.country },
    items: (od.order_items ?? []).map((i) => ({ name: i.name })),
  });
  // Add-ons with no service change (Kai, 2026-10-08): only the folder decides,
  // exactly as for the page (Completed Orders is the one closed folder).
  if (change.addOns?.length && change.to === change.from) {
    return stage.window === 'closed' ? { allowed: false, reason: 'shipping', label: stage.label } : { allowed: true };
  }
  const ok = isPickup(od.shipping_method)
    ? stage.canConvert && stage.convertTo.includes(change.to)
    : stage.canUpgrade && (stage.upgradeOptions ?? [stage.upgradeTo]).includes(change.to);
  return ok ? { allowed: true } : { allowed: false, reason: stage.blockedBy ?? 'no_longer_offered', label: stage.label };
}
