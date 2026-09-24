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
 * B2SIGN orders are fulfilled by a supplier. Changing one means Danny phoning
 * them to ask whether it is still possible, which is not something a customer
 * can do from a web page, so these are left exactly as they are today.
 *
 * Four product families, confirmed against the live catalogue (Kai,
 * 2026-09-24). Matched on the product rather than the folder, because an order
 * can carry one of these before it has been routed anywhere.
 *
 * The `flag` test is the store's own: the external intake Lambda already sends
 * any item whose name contains "flag" to the Flag Banner folder
 * (docs/shopify-intake-lambda.md). Using the same word here keeps one rule
 * rather than two that can drift.
 */
const B2SIGN_PATTERNS = [
  /\bflags?\b/,        // Feather Angled / Feather Convex / Teardrop / Rectangle
  /\btents?\b/,        // 10ft and 15ft Event Tent, and their half and full walls
  /\byard\s*signs?\b/,
  /\bcanvas\s*wraps?\b/,
];

/**
 * Every B2SIGN product as the catalogue names it today. Not used for matching —
 * the patterns above do that, so a new size or a renamed variant is still
 * caught — but kept here as the list the tests check the patterns against. If
 * a product is added to this family, add it here and the test proves the
 * patterns already cover it.
 */
export const B2SIGN_CATALOGUE = [
  'Feather Angled Flag (Small)', 'Feather Angled Flag (Medium)',
  'Feather Angled Flag (Large)', 'Feather Angled Flag (X-Large)',
  'Feather Convex Flag (Small)', 'Feather Convex Flag (Medium)',
  'Feather Convex Flag (Large)',
  'Teardrop Flag (Small)', 'Teardrop Flag (Medium)', 'Teardrop Flag (Large)',
  'Rectangle Flag (Small)', 'Rectangle Flag (Medium)', 'Rectangle Flag (Large)',
  '10ft Event Tent', '10ft Tent Half Wall', '10ft Tent Full Walls',
  '15ft Event Tent', '15ft Tent Half Walls', '15ft Tent Full Walls',
  'Yard Sign', 'Canvas Wrap',
];

export function isB2Sign(items = []) {
  return (items ?? []).some((it) => {
    const name = String(it?.name ?? '').toLowerCase();
    return B2SIGN_PATTERNS.some((re) => re.test(name));
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
