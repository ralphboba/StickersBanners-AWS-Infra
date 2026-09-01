// ===========================================================================
// SKU RULES  —  one place to see and edit how each product is processed.
// ===========================================================================
//
// A "SKU" is the product code on each order line. Examples:
//     SKUVB          = Custom Vinyl Banner
//     SKUFPUD08X10   = Fabric Pop Up Display (10'x8')
//     SKUAB / SKUST  = adhesive / sticker products
//
// Different products need different handling, and these lists decide it. When a
// NEW product is added by the store, add its SKU to the right list below — no
// other code needs to change. This file is the single source of truth for
// SKU-based decisions in the intake logic (src/shared/orderdesk.mjs).
//
// (Note: the Python image containers keep small fallback copies of a couple of
//  these lists; if you change something here, mirror it there too.)
// ---------------------------------------------------------------------------


// --- 1. Dimension unit: inches vs feet -------------------------------------
// Most banners are quoted in FEET (e.g. 6 x 5 = 6ft x 5ft). The products below
// are quoted in INCHES instead (e.g. SKUFPUD08X10 = 145 x 91 inches).
// Symptom of a missing entry: a size reads absurdly large (145 treated as 145
// FEET). Add the SKU (exact) or a family prefix to fix it.
export const INCH_SKUS = [
  'SKUPB', 'SKUXB', 'SKU-543', 'SKU-545',
  'SKU-DXB-B', 'SKU-DXB', 'SKUDXBB', 'SKUDXBBB',
];
export const INCH_SKU_PREFIXES = [
  'SKUFPUD', // Fabric Pop Up Display (all sizes: SKUFPUD08X10, SKUFPUD10X10, …)
];


// --- 2. Products with NO image finishing -----------------------------------
// These skip grommets / pole pockets entirely (plain copy) — e.g. stickers.
export const NO_FINISH_SKUS = ['SKUAB', 'SKUST', 'SKU10ET']; // SKU10ET = 10ft Event Tent


// --- 3. Hardware-only items (NOT image-processed at all) --------------------
// Stands, poles, and other physical hardware. The legacy program filtered these
// out; list to be populated from the hardware sheet. Empty = filter off for now.
export const HARDWARE_SKUS = [];
export const HARDWARE_SKU_PREFIXES = [];


// --- 4. Known product families (for the "unknown SKU" alert) ---------------
// SKUs the system has been set up for. When an order arrives with a SKU that
// matches NONE of these, it's flagged as an unknown/new product so staff can
// review it (see how it should be sized/finished) — the dashboard shows a
// warning and the poller logs it. When a NEW product line launches, add its
// prefix here. Seeded from the store's current catalogue.
export const KNOWN_SKU_PREFIXES = [
  'SKUVB',   // vinyl banner            SKUAB — adhesive
  'SKUAB', 'SKUPB', 'SKUXB', 'SKUMB', 'SKUST', 'SKUVS', 'SKUDC',
  'SKUCSR', 'SKUCFSR',        // custom (fabric) step & repeat
  'SKUSR',  'SKUFSR',         // step & repeat / fabric step & repeat (all sizes)
  'SKUBS',  'SKURC',          // backdrop stand / retractable
  'SKUFPUD', 'SKU08',         // fabric pop up display families
  'SKU10ET',                  // 10ft Event Tent (feet, no finishing)
  'SKU-',                     // numbered SKUs (SKU-543, SKU-602, …)
];

export function isKnownSku(sku) {
  const s = String(sku ?? '');
  if (!s) return true; // empty/missing SKU is a separate problem, not "unknown"
  return KNOWN_SKU_PREFIXES.some((p) => s.startsWith(p));
}


// --- helpers (used by the intake logic) ------------------------------------
export function isInchSku(sku) {
  const s = String(sku ?? '');
  return INCH_SKUS.includes(s) || INCH_SKU_PREFIXES.some((p) => s.startsWith(p));
}

export function isNoFinishSku(sku) {
  return NO_FINISH_SKUS.includes(String(sku ?? ''));
}

export function isHardwareSku(sku) {
  const s = String(sku ?? '');
  return HARDWARE_SKUS.includes(s) || HARDWARE_SKU_PREFIXES.some((p) => s.startsWith(p));
}
