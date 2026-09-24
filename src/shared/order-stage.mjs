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
import { ineligibleReason } from './upgrade-eligibility.mjs';

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
const OFF_LADDER = [
  'saturday', 'sat overnight',   // availability depends on the address (Danny)
  'ground',                      // express only (Danny)
  'pickup', 'pick-up', 'pick up',
];

// ── the exact strings OrderDesk holds ──────────────────────────────────────
// `to` is written verbatim into shipping_method, so it has to be the text the
// store actually uses. Anything else gives one service two spellings, and an
// OrderDesk rule or ShipStation mapping that matches on the text misses one.
//
// All four confirmed against the live store (Kai, 2026-09-14; 'FedEx 1-Day'
// also seen on order S60338). Note the plural: three and two are "-Days", one
// is "-Day". Guessing a consistent scheme would have written 'FedEx 2-Day' and
// left the store holding two spellings of one service.
//
// ⚠️ routing.mjs's express upgrade writes '2-day Shipping', which is none of
// these. That legacy write is behind ORDERDESK_WRITES and still off, so it has
// not done damage — but it is wrong and would set an unrecognised service on a
// real order the day that switch is armed. See docs/legacy-collision-audit.md C5.
const SERVICE = {
  ground: 'FedEx Ground',   // recognised for display; never an upgrade target
  d3: 'FedEx 3-Days',
  d2: 'FedEx 2-Days',
  d1: 'FedEx 1-Day',
};

// One rung at a time, and the ladder starts at 3-Days.
//
// Ground is NOT on it: "If the order is ground shipping, we cannot upgrade. If
// the order is express, we can upgrade" (Danny, 2026-09-24; Kai confirmed).
// Ground and express are different operations, not two speeds of one, so a
// Ground order is refused outright rather than quoted a price we cannot honour.
const LADDER = [
  // Substring matches, so '3-day' also catches 'FedEx 3-Days'. Reading is
  // forgiving; writing uses SERVICE above and is exact.
  { match: ['3-day', '3 day', 'three day'], from: SERVICE.d3, to: SERVICE.d2 },
  { match: ['2-day', '2 day', '2day', 'two day'], from: SERVICE.d2, to: SERVICE.d1 },
  { match: ['1-day', '1 day', 'overnight', 'one day'], from: SERVICE.d1, to: null },
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
 * Everything the customer page needs about one order.
 *
 * Three separate questions decide whether an upgrade may be offered, and the
 * customer is told which one said no:
 *   · is it too late?            the folder (the cutoff)
 *   · is there anything to sell? the ladder
 *   · may we sell it at all?     the destination and the product (Danny's rules)
 *
 * @param {{ folderId: string|number, shippingMethod?: string,
 *           shipping?: object, items?: Array<object> }} order
 */
export function orderStage({ folderId, shippingMethod, shipping, items } = {}) {
  const folder = folderById(folderId);
  const copy = folder ? STAGE_COPY[folder.stage] : null;

  const stage = folder?.stage ?? UNKNOWN_STAGE.stage;
  const label = copy?.label ?? UNKNOWN_STAGE.label;
  const step = copy?.step ?? UNKNOWN_STAGE.step;

  const modifiable = isModifiable(folderId);
  const ladder = nextService(shippingMethod);

  // ── never charge for what the legacy bot may hand over for free ──────────
  // Linh's changeExpress upgrades a 3-day order to 2-day for nothing when it is
  // routed between 3pm and 6pm ET (routing.mjs). That decision is made when the
  // order leaves for a facility. So while an order is still unrouted we cannot
  // know whether it is about to be upgraded free, and selling it the same
  // upgrade would take money for something the customer was going to get.
  //
  // Once the order sits in a facility folder the legacy bot has already had its
  // say: if it is still on 3-day, it was not upgraded, and the upgrade is
  // genuinely ours to sell. Time is not consulted — the rule holds whenever the
  // page is opened.
  const routed = Boolean(folder?.facility);
  const legacyMayUpgradeFree = ladder?.from === SERVICE.d3 && !routed;

  // The reasons to refuse, in the order they are checked.
  // Checked before the ladder: a B2SIGN order or a PO box is refused whatever
  // service it is on, and saying "already on our fastest" to one of those would
  // be both wrong and confusing.
  const ineligible = ineligibleReason({ shipping, items });

  let blockedBy = null;
  if (!modifiable) blockedBy = folder ? 'shipping' : 'unknown_folder';
  else if (ineligible) blockedBy = ineligible.blockedBy;
  else if (!ladder) blockedBy = 'service_not_upgradable';
  else if (ladder.top) blockedBy = 'already_fastest';
  else if (legacyMayUpgradeFree) blockedBy = 'awaiting_routing';

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
