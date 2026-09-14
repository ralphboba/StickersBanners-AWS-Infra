// Turning an OrderDesk folder into something a customer may read.
//
// Two jobs, deliberately in one place:
//   1. stage    — where the order is, in words a customer understands
//   2. canUpgrade / nextService — whether they may still change it, and to what
//
// ── Why the translation lives here and not in the registry ─────────────────
// Folder names are operational. "Missing/Corrupted File" and "Pending Review"
// are true and useful to staff, and alarming to the person who paid. Because
// the registry carries only an internal `stage` enum, there is no path by which
// a folder name reaches a customer's screen — not by carefulness, by structure.
//
// Every unknown folder falls back to the vaguest honest stage and to
// canUpgrade: false. This gates a charge; "I do not recognise this folder" must
// never read as yes.

import { folderById, isModifiable, facilityOf } from './orderdesk-folders.mjs';

/** Internal stage -> what the customer sees, and where it sits on the tracker. */
const STAGE_COPY = {
  received:         { label: 'Order received',  step: 0 },
  proofing:         { label: 'Proof sent',      step: 1 },
  in_progress:      { label: 'Being prepared',  step: 1 },
  in_production:    { label: 'In production',   step: 2 },
  ready_to_ship:    { label: 'Ready to ship',   step: 3 },
  ready_for_pickup: { label: 'Ready for pickup', step: 3 },
  completed:        { label: 'Shipped',         step: 4 },
};

/** Shown when the folder is not in the registry. Vague, true, and not alarming. */
const UNKNOWN_STAGE = { stage: 'in_progress', label: 'Being prepared', step: 1 };

export const STEPS = ['Order received', 'Proof approved', 'In production', 'Ready to ship', 'Shipped'];

// ── the upgrade ladder (Kai, 2026-09-14) ───────────────────────────────────
// One notch, and one notch only. A customer on 3-Day may buy 2-Day; on 2-Day
// may buy 1-Day; on 1-Day there is nothing left to sell. Saturday Overnight is
// not on the ladder and is never offered self-service.
//
// The facility NEVER changes. Legacy intake routing pulls express orders to NV
// (routing.mjs, the 3-6pm cutoff), but that is a decision made before any work
// exists. An order already being printed in GA stays in GA — re-routing it to
// NV would throw away the work. So an upgrade writes shipping_method and
// nothing else: no folder move, no re-route.
// Checked BEFORE the ladder. "Saturday Overnight" contains "overnight" and
// would otherwise be read as a 1-Day order — wrong service, wrong price, and
// the page would tell the customer they are already on 1-Day when they are not.
const OFF_LADDER = ['saturday', 'sat overnight', 'ground', 'pickup', 'pick-up', 'pick up'];

const LADDER = [
  { match: ['3-day', '3 day', 'three day'], from: '3-Day Shipping', to: '2-Day Shipping' },
  { match: ['2-day', '2 day', '2day', 'two day'], from: '2-Day Shipping', to: '1-Day Shipping' },
  { match: ['1-day', '1 day', 'overnight', 'one day'], from: '1-Day Shipping', to: null },
];

/**
 * The next service up from what the customer already has.
 * @param {string} shippingMethod  the order's current shipping_method
 * @returns {{ from: string, to: string|null, top: boolean } | null}
 *          null when the method is not on the ladder at all (Ground, pickup,
 *          anything unrecognised) — those get no self-service upgrade.
 */
export function nextService(shippingMethod) {
  const m = String(shippingMethod ?? '').toLowerCase();
  if (OFF_LADDER.some((k) => m.includes(k))) return null;
  for (const rung of LADDER) {
    if (rung.match.some((k) => m.includes(k))) {
      return { from: rung.from, to: rung.to, top: rung.to === null };
    }
  }
  return null;
}

/**
 * Everything the customer page needs about one order, from its folder and
 * current shipping method.
 *
 * @param {{ folderId: string|number, shippingMethod?: string }} order
 */
export function orderStage({ folderId, shippingMethod } = {}) {
  const folder = folderById(folderId);
  const copy = folder ? STAGE_COPY[folder.stage] : null;

  const stage = folder?.stage ?? UNKNOWN_STAGE.stage;
  const label = copy?.label ?? UNKNOWN_STAGE.label;
  const step = copy?.step ?? UNKNOWN_STAGE.step;

  const modifiable = isModifiable(folderId);
  const ladder = nextService(shippingMethod);

  // Three separate reasons to refuse, and the customer is told which.
  let blockedBy = null;
  if (!modifiable) blockedBy = folder ? 'shipping' : 'unknown_folder';
  else if (!ladder) blockedBy = 'service_not_upgradable';
  else if (ladder.top) blockedBy = 'already_fastest';

  return {
    stage,
    label,
    step,
    facility: facilityOf(folderId),
    known: Boolean(folder),
    canUpgrade: blockedBy === null,
    blockedBy,
    currentService: ladder?.from ?? (shippingMethod ?? null),
    upgradeTo: blockedBy === null ? ladder.to : null,
  };
}
