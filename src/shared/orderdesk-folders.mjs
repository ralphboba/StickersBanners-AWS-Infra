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
// Kai (2026-10-08): "Unless the order is in Completed Orders, it can be
// upgraded" — any folder, Awaiting Shipment and Awaiting Pickup included, and
// a folder this list does not know. Completed Orders (shipped) is the only
// closed one:
//
//   open    anything on the ladder, and a pickup may become a delivery
//   closed  nothing — Completed Orders only
//
// (Until 2026-10-08 Awaiting Shipment/Pickup were "restricted" — Ground could
// not change — and Pay By Check and unknown folders were closed. A real
// customer, S67179 in NJ Awaiting Shipment, was refused because of it.)

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
  { id: '698334', name: 'QTS - Pay By Check', stage: 'received', mirror: 'in_progress', window: 'open' },
  { id: '650227', key: 'processing', name: 'Processing', stage: 'in_progress', mirror: 'in_progress', window: 'open' },
  { id: '651474', key: 'proofing', name: 'Proofing', stage: 'proofing', mirror: 'proofing', window: 'open' },
  { id: '653109', key: 'review', name: 'Pending Review', stage: 'in_progress', mirror: 'needs_review', window: 'open' },
  { id: '661019', name: 'Missing/Corrupted File', stage: 'in_progress', mirror: 'needs_review', window: 'open' },
  { id: '652268', key: 'manual', name: 'Manual', stage: 'in_progress', mirror: 'in_progress', window: 'open' },
  { id: '657836', key: 'sales', name: 'Sales', stage: 'in_progress', mirror: 'in_progress', window: 'open' },
  { id: '31358', name: 'Awaiting Admin', stage: 'in_progress', mirror: 'awaiting_admin', window: 'open' },

  // ── scheduling: the office drops orders here to start the routing cascade ─
  { id: '73066', name: 'Today', stage: 'in_progress', mirror: 'in_progress', window: 'open' },
  { id: '73067', name: 'Tomorrow', stage: 'in_progress', mirror: 'in_progress', window: 'open' },

  // ── production ────────────────────────────────────────────────────────────
  { id: '73068', key: 'GA', name: 'GA', stage: 'in_production', mirror: 'production_ga', facility: 'GA', window: 'open' },
  { id: '73069', key: 'NJ', name: 'NJ', stage: 'in_production', mirror: 'production_nj', facility: 'NJ', window: 'open' },
  { id: '73070', key: 'TX', name: 'TX', stage: 'in_production', mirror: 'production_tx', facility: 'TX', window: 'open' },
  { id: '674352', key: 'NV', name: 'NV', stage: 'in_production', mirror: 'production_nv', facility: 'NV', window: 'open' },
  { id: '42928', key: 'CA', name: 'CA', stage: 'in_production', mirror: 'production_ca', facility: 'CA', window: 'open' },

  // ── ★ the cutoff. Entering one of these sends the order to ShipStation, so
  //      nothing about it may change from here on.
  { id: '3571', name: 'GA Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_ga', facility: 'GA', window: 'open' },
  { id: '43256', name: 'NJ Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_nj', facility: 'NJ', window: 'open' },
  { id: '43257', name: 'TX Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_tx', facility: 'TX', window: 'open' },
  { id: '674353', name: 'NV Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_nv', facility: 'NV', window: 'open' },
  { id: '79040', name: 'CA Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_ca', facility: 'CA', window: 'open' },

  // ── pickup ────────────────────────────────────────────────────────────────
  { id: '31301', name: 'GA Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_ga', facility: 'GA', window: 'open' },
  { id: '52437', name: 'NJ Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_nj', facility: 'NJ', window: 'open' },
  { id: '52438', name: 'TX Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_tx', facility: 'TX', window: 'open' },
  { id: '674908', name: 'NV Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_nv', facility: 'NV', window: 'open' },
  { id: '82463', name: 'CA Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_ca', facility: 'CA', window: 'open' },

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

/**
 * Display-only mirror: folder id -> dashboard status.
 *
 * 'in_progress' is not a dashboard lane, so those rows don't show on the board.
 * They exist for the customer's "Manage my order" page, which needs the order's
 * row (and its Shopify link) wherever the order sits — Linh's program moves
 * orders out of QTS into Manual, Processing and the rest within minutes
 * (S66306, 2026-10-06: moved to Manual, page refused it).
 */
export const MIRROR_STATUS_BY_ID = Object.freeze(
  Object.fromEntries(FOLDERS.filter((f) => f.mirror).map((f) => [f.id, f.mirror])),
);

/** Folder ids that mean production has finished (informational; still open). */
export const AWAITING_SHIPMENT_IDS = Object.freeze(
  FOLDERS.filter((f) => f.stage === 'ready_to_ship').map((f) => f.id),
);

/**
 * How much may a customer change, given where the order is?
 * Only Completed Orders is closed; every other folder — including one somebody
 * added in Order Desk this morning — is open (Kai, 2026-10-08).
 *
 * @param {string|number} folderId
 * @returns {'open'|'closed'}
 */
export function windowOf(folderId) {
  return folderById(folderId)?.window === 'closed' ? 'closed' : 'open';
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
