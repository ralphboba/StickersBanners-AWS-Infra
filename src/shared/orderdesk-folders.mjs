// Every OrderDesk folder this system knows about — one registry, one truth.
//
// The ids used to live in two places that overlapped and disagreed:
// ORDERDESK_FOLDERS in intake-gate.mjs (name -> id, for writing) and
// MIRROR_FOLDERS in the poller (id -> dashboard status, for reading). Proofing
// and Pending Review appeared in both; the production folders appeared only in
// the first, and Awaiting Shipment in neither. Both maps are now derived from
// the rows below, so a folder cannot exist in one view and be missing from the
// other.
//
// ── `window` is a property of the row, not a separate list ─────────────────
// How much a customer may change depends on where the order is, and there are
// three answers rather than two (Kai, 2026-09-28):
//
//   open        anything on the ladder
//   restricted  production is finished. Express may still move up and a pickup
//               may still become a delivery, but Ground cannot: it is already
//               manifested for the Ground collection.
//   closed      nothing
//
// Keeping it as a field means adding a folder forces a decision about it. A
// separate array of "locked folder ids" would eventually drift from this list;
// a field cannot.
//
// Customer-facing wording is deliberately NOT here — `stage` is an internal
// enum and order-stage.mjs translates it. That way an internal name like
// "Missing/Corrupted File" has no path to a customer's screen.

/**
 * @typedef {'received'|'proofing'|'in_progress'|'in_production'
 *           |'ready_to_ship'|'ready_for_pickup'|'completed'} Stage
 */

/**
 * One row per folder.
 *  id          OrderDesk folder id (string — the API uses strings)
 *  key         name used by ORDERDESK_FOLDERS when the intake gate writes here
 *  name        the folder's name in OrderDesk, for logs and staff-facing views
 *  stage       internal lifecycle stage
 *  mirror      dashboard status for the display-only mirror, when shown
 *  facility    GA/NJ/TX/NV/CA when the folder belongs to one
 *  window      'open' | 'restricted' | 'closed' — see the note above
 */
export const FOLDERS = [
  // ── intake ────────────────────────────────────────────────────────────────
  { id: '665685', name: 'QTS', stage: 'received', mirror: 'in_queue', window: 'open' },
  { id: '698334', name: 'QTS - Pay By Check', stage: 'received', window: 'closed' },
  { id: '650227', key: 'processing', name: 'Processing', stage: 'in_progress', window: 'open' },
  { id: '651474', key: 'proofing', name: 'Proofing', stage: 'proofing', mirror: 'proofing', window: 'open' },
  // Not a "needs a person" folder despite the name. Linh (2026-10-05): an
  // approved order "sent to Pending review and then the python bot generate
  // the final PR and then send those to productions" — so it is mid-printing.
  { id: '653109', key: 'review', name: 'Pending Review', stage: 'in_progress', mirror: 'printing', window: 'open' },
  { id: '661019', name: 'Missing/Corrupted File', stage: 'in_progress', mirror: 'needs_review', window: 'open' },
  { id: '652268', key: 'manual', name: 'Manual', stage: 'in_progress', window: 'open' },
  { id: '657836', key: 'sales', name: 'Sales', stage: 'in_progress', window: 'open' },
  { id: '31358', name: 'Awaiting Admin', stage: 'in_progress', mirror: 'awaiting_admin', window: 'open' },

  // ── scheduling: the office drops orders here to start the routing cascade ─
  { id: '73066', name: 'Today', stage: 'in_progress', window: 'open' },
  { id: '73067', name: 'Tomorrow', stage: 'in_progress', window: 'open' },

  // ── production ────────────────────────────────────────────────────────────
  { id: '73068', key: 'GA', name: 'GA', stage: 'in_production', mirror: 'production_ga', facility: 'GA', window: 'open' },
  { id: '73069', key: 'NJ', name: 'NJ', stage: 'in_production', mirror: 'production_nj', facility: 'NJ', window: 'open' },
  { id: '73070', key: 'TX', name: 'TX', stage: 'in_production', mirror: 'production_tx', facility: 'TX', window: 'open' },
  { id: '674352', key: 'NV', name: 'NV', stage: 'in_production', mirror: 'production_nv', facility: 'NV', window: 'open' },
  { id: '42928', key: 'CA', name: 'CA', stage: 'in_production', mirror: 'production_ca', facility: 'CA', window: 'open' },

  // ── ★ the cutoff. Entering one of these sends the order to ShipStation, so
  //      nothing about it may change from here on.
  { id: '3571', name: 'GA Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_ga', facility: 'GA', window: 'restricted' },
  { id: '43256', name: 'NJ Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_nj', facility: 'NJ', window: 'restricted' },
  { id: '43257', name: 'TX Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_tx', facility: 'TX', window: 'restricted' },
  { id: '674353', name: 'NV Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_nv', facility: 'NV', window: 'restricted' },
  { id: '79040', name: 'CA Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_ca', facility: 'CA', window: 'restricted' },

  // ── pickup ────────────────────────────────────────────────────────────────
  { id: '31301', name: 'GA Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_ga', facility: 'GA', window: 'restricted' },
  { id: '52437', name: 'NJ Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_nj', facility: 'NJ', window: 'restricted' },
  { id: '52438', name: 'TX Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_tx', facility: 'TX', window: 'restricted' },
  { id: '674908', name: 'NV Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_nv', facility: 'NV', window: 'restricted' },
  { id: '82463', name: 'CA Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_ca', facility: 'CA', window: 'restricted' },

  // ── staff test orders ─────────────────────────────────────────────────────
  // Kai's own folder for test orders (S64262). Nothing real is filed here and
  // no legacy rule reads it. Treated as before production so the customer
  // shipping change can be exercised end to end; not mirrored, not written to.
  { id: '711436', name: 'Kai-TEST-processed', stage: 'proofing', window: 'open' },

  // ── end of the line ───────────────────────────────────────────────────────
  { id: '3516', name: 'Completed Orders', stage: 'completed', window: 'closed' },
];

const byId = new Map(FOLDERS.map((f) => [f.id, f]));

/** @param {string|number} folderId */
export function folderById(folderId) {
  return byId.get(String(folderId ?? '')) ?? null;
}

/** Legacy folderLib shape: name -> id, for the intake gate's writes. */
export const ORDERDESK_FOLDERS = Object.freeze(
  Object.fromEntries(FOLDERS.filter((f) => f.key).map((f) => [f.key, f.id])),
);

/** Display-only mirror: folder id -> dashboard status. */
export const MIRROR_STATUS_BY_ID = Object.freeze(
  Object.fromEntries(FOLDERS.filter((f) => f.mirror).map((f) => [f.id, f.mirror])),
);

/** Folder ids that mean production has finished — the restricted window. */
export const AWAITING_SHIPMENT_IDS = Object.freeze(
  FOLDERS.filter((f) => f.stage === 'ready_to_ship').map((f) => f.id),
);

/**
 * How much may a customer change, given where the order is?
 *
 * Fails CLOSED. An id we do not recognise — a folder somebody added in
 * OrderDesk this morning — returns 'closed'. This decision gates a charge, so
 * the safe answer to "I do not know" is nothing.
 *
 * @param {string|number} folderId
 * @returns {'open'|'restricted'|'closed'}
 */
export function windowOf(folderId) {
  const w = folderById(folderId)?.window;
  return w === 'open' || w === 'restricted' ? w : 'closed';
}

/** Anything at all still changeable here? Convenience over windowOf. */
export function isModifiable(folderId) {
  return windowOf(folderId) !== 'closed';
}

/** The facility that owns the order, or null. Never changes on an upgrade. */
export function facilityOf(folderId) {
  return folderById(folderId)?.facility ?? null;
}

/**
 * Which facility's Chat space hears about this order? Kai (2026-10-02): "TX가
 * 들어간 모든 폴더는 TX로", same for GA and NJ. A folder in the list above
 * answers by its facility; any other folder (one added in Order Desk later)
 * answers by its name, when Order Desk sends it: GA, NJ or TX as a separate
 * word. Only routes a notice — never decides what may change.
 *
 * @param {string|number} folderId
 * @param {string} [folderName]  Order Desk's folder_name, if the response has it
 * @returns {'GA'|'NJ'|'TX'|string|null}
 */
export function chatFacilityOf(folderId, folderName) {
  const known = facilityOf(folderId);
  if (known) return known;
  const m = String(folderName ?? '').toUpperCase().match(/(?:^|[^A-Z])(GA|NJ|TX)(?=[^A-Z]|$)/);
  return m ? m[1] : null;
}
