// Who may NOT be sold a shipping upgrade, regardless of where their order is.
//
// These come from Danny (2026-09-24), and they are about what the business can
// actually do, not about what the rate card can price. Every rule here is a
// refusal: the rate card will happily quote a 1-Day to Honolulu, and we would
// then have to refund it.
//
// Where a rule is inferred rather than stated, it says so — and it still
// refuses, because Danny's instruction was to over-restrict at the start.

/**
 * Destinations the store does not ship to at all (Danny). An order to one of
 * these should not exist, but if one does, it certainly cannot be upgraded.
 *
 * AA/AE/AP (military) are INFERRED from "we don't ship to PO", not stated.
 * They behave like PO boxes for a courier, so they are refused too.
 */
export const NO_SHIP_REGIONS = new Set([
  'HI', 'AK', 'PR', 'VI',   // Danny: Hawaii, Alaska, Puerto Rico, US Virgin Islands
  'AA', 'AE', 'AP',         // inferred: APO/FPO/DPO
]);

/** Spelled-out forms, since order data is not always a two-letter code. */
const REGION_NAMES = [
  'hawaii', 'alaska', 'puerto rico', 'virgin islands',
];

/**
 * A PO box, in the spellings that actually turn up in address lines.
 * Deliberately broad: "P.O. Box", "PO BOX", "POBox", "Post Office Box".
 * A street genuinely named something like "Post Road" must not match, so the
 * pattern requires the word "box" (or the bare "po box" form).
 */
const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|postal\s+box)\b/i;

export function isPoBox(...addressLines) {
  return addressLines.some((l) => PO_BOX.test(String(l ?? '')));
}

/** Is this address somewhere the store does not ship? */
export function isNoShipDestination({ state, country } = {}) {
  const s = String(state ?? '').trim();
  if (s.length === 2 && NO_SHIP_REGIONS.has(s.toUpperCase())) return true;
  const lower = s.toLowerCase();
  if (REGION_NAMES.some((n) => lower === n)) return true;
  // Puerto Rico and the USVI sometimes arrive as the country rather than the state.
  const c = String(country ?? '').trim().toLowerCase();
  return REGION_NAMES.some((n) => c === n);
}

/**
 * B2SIGN orders are fulfilled by a supplier, and changing one means Danny
 * phoning them to ask whether it is still possible. That is not something a
 * customer can do from a web page, so these are left exactly as they are today.
 *
 * Matched on the product, because an order can carry a B2SIGN item without
 * having reached a B2SIGN folder yet.
 *
 * ⚠️ The list is from docs/shopify-intake-lambda.md (the external intake
 * Lambda's own routing). Confirm it against the live product list before
 * arming writes — a B2SIGN product missing from here is one a customer could
 * upgrade and Danny then has to unpick by phone.
 */
const B2SIGN_PRODUCTS = [
  'canvas wrap',
  'yard sign',
  '10ft tent', '10 ft tent', "10' tent",
  '15ft tent', '15 ft tent', "15' tent",
  'tent wall',
];

export function isB2Sign(items = []) {
  return (items ?? []).some((it) => {
    const name = String(it?.name ?? '').toLowerCase();
    return B2SIGN_PRODUCTS.some((p) => name.includes(p));
  });
}

/**
 * May this order be offered a shipping upgrade at all?
 *
 * Answers only the questions about WHAT the order is and WHERE it is going.
 * Whether it is too late (the folder) and whether there is a faster service to
 * sell (the ladder) are order-stage.mjs's business.
 *
 * @param {{ shipping?: object, items?: Array<object> }} order
 * @returns {null | { blockedBy: string }} null when nothing here objects
 */
export function ineligibleReason({ shipping, items } = {}) {
  if (isB2Sign(items)) return { blockedBy: 'supplier_order' };
  if (isNoShipDestination(shipping)) return { blockedBy: 'destination' };
  if (isPoBox(shipping?.street, shipping?.street2)) return { blockedBy: 'po_box' };
  return null;
}
