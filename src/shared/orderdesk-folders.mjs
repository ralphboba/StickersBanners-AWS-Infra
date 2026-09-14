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
// ── `modifiable` is a property of the row, not a separate list ──────────────
// The modification cutoff is "has the order reached <facility> Awaiting
// Shipment" (docs/order-lifecycle-and-refunds.md). Keeping that as a field
// means adding a folder forces a decision about it. A separate array of
// "locked folder ids" would eventually drift from this list; a field cannot.
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
 *  modifiable  may a customer still change this order?
 */
export const FOLDERS = [
  // ── intake ────────────────────────────────────────────────────────────────
  { id: '665685', name: 'QTS', stage: 'received', mirror: 'in_queue', modifiable: true },
  { id: '698334', name: 'QTS - Pay By Check', stage: 'received', modifiable: false },
  { id: '650227', key: 'processing', name: 'Processing', stage: 'in_progress', modifiable: true },
  { id: '651474', key: 'proofing', name: 'Proofing', stage: 'proofing', mirror: 'proofing', modifiable: true },
  { id: '653109', key: 'review', name: 'Pending Review', stage: 'in_progress', mirror: 'needs_review', modifiable: true },
  { id: '661019', name: 'Missing/Corrupted File', stage: 'in_progress', mirror: 'needs_review', modifiable: true },
  { id: '652268', key: 'manual', name: 'Manual', stage: 'in_progress', modifiable: true },
  { id: '657836', key: 'sales', name: 'Sales', stage: 'in_progress', modifiable: true },
  { id: '31358', name: 'Awaiting Admin', stage: 'in_progress', mirror: 'awaiting_admin', modifiable: true },

  // ── scheduling: the office drops orders here to start the routing cascade ─
  { id: '73066', name: 'Today', stage: 'in_progress', modifiable: true },
  { id: '73067', name: 'Tomorrow', stage: 'in_progress', modifiable: true },

  // ── production ────────────────────────────────────────────────────────────
  { id: '73068', key: 'GA', name: 'GA', stage: 'in_production', mirror: 'production_ga', facility: 'GA', modifiable: true },
  { id: '73069', key: 'NJ', name: 'NJ', stage: 'in_production', mirror: 'production_nj', facility: 'NJ', modifiable: true },
  { id: '73070', key: 'TX', name: 'TX', stage: 'in_production', mirror: 'production_tx', facility: 'TX', modifiable: true },
  { id: '674352', key: 'NV', name: 'NV', stage: 'in_production', mirror: 'production_nv', facility: 'NV', modifiable: true },
  { id: '42928', key: 'CA', name: 'CA', stage: 'in_production', mirror: 'production_ca', facility: 'CA', modifiable: true },

  // ── ★ the cutoff. Entering one of these sends the order to ShipStation, so
  //      nothing about it may change from here on.
  { id: '3571', name: 'GA Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_ga', facility: 'GA', modifiable: false },
  { id: '43256', name: 'NJ Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_nj', facility: 'NJ', modifiable: false },
  { id: '43257', name: 'TX Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_tx', facility: 'TX', modifiable: false },
  { id: '674353', name: 'NV Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_nv', facility: 'NV', modifiable: false },
  { id: '79040', name: 'CA Awaiting Shipment', stage: 'ready_to_ship', mirror: 'awaiting_ship_ca', facility: 'CA', modifiable: false },

  // ── pickup ────────────────────────────────────────────────────────────────
  { id: '31301', name: 'GA Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_ga', facility: 'GA', modifiable: false },
  { id: '52437', name: 'NJ Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_nj', facility: 'NJ', modifiable: false },
  { id: '52438', name: 'TX Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_tx', facility: 'TX', modifiable: false },
  { id: '674908', name: 'NV Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_nv', facility: 'NV', modifiable: false },
  { id: '82463', name: 'CA Awaiting Pickup', stage: 'ready_for_pickup', mirror: 'pickup_ca', facility: 'CA', modifiable: false },

  // ── end of the line ───────────────────────────────────────────────────────
  { id: '3516', name: 'Completed Orders', stage: 'completed', modifiable: false },
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

/** Folder ids that mean the order is already on its way to ShipStation. */
export const AWAITING_SHIPMENT_IDS = Object.freeze(
  FOLDERS.filter((f) => f.stage === 'ready_to_ship').map((f) => f.id),
);

/**
 * May a customer still change this order?
 *
 * Fails CLOSED. An id we do not recognise — a folder somebody added in
 * OrderDesk this morning — returns false. This decision gates a charge, so the
 * safe answer to "I do not know" is no.
 *
 * @param {string|number} folderId
 */
export function isModifiable(folderId) {
  return folderById(folderId)?.modifiable === true;
}

/** The facility that owns the order, or null. Never changes on an upgrade. */
export function facilityOf(folderId) {
  return folderById(folderId)?.facility ?? null;
}
