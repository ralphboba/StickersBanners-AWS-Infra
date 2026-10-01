// Which demo slot to feed next.
//
// Split out from index.mjs (which loads the AWS SDK) so the choice itself is
// testable. It looks trivial, and the version it replaces was too: the old
// handler scanned slots 1..N and fed the first free one, then returned. Slot 1
// finishes long before the next 10-minute tick, so slot 1 was always the first
// free one — DEMO-1 was re-fed 60 times in a row and slots 2..8 never ran once.
//
// That mattered more than a dull dashboard. Those slots are the only exercise
// the image containers get: the variants carry pole pockets, cut-only, the 8x8
// remap, and the proof branch, and none of that code had ever executed in AWS.
//
// So the rule is now "least recently fed", not "first free": a slot that has
// never run outranks every slot that has, and among slots that have run, the
// oldest wins. Self-correcting — no cursor to persist and get out of sync, and
// a slot that fails and frees up early cannot starve the others.

/** A slot still moving through the pipeline; leave it alone. */
export const BUSY = new Set(['in_queue', 'printing', 'proofing']);

/**
 * How long a slot may sit "busy" before we assume it is stuck and recycle it.
 *
 * The pipeline takes about two minutes, so anything still busy hours later is
 * not moving. This is not hypothetical: DEMO-2/4/6 are the slots whose orders
 * need a proof, and they parked at `proofing` on 2026-08-28 waiting for an
 * approval that nobody was ever going to give. Without an escape, the three
 * variants that exercise the proof branch are exactly the three that can never
 * run again.
 *
 * Recycling a slot whose execution is still paused at WaitForApproval orphans
 * that execution; it expires on the state machine's own 7-day timeout. That is
 * an acceptable cost for a synthetic board and affects no real order.
 */
export const STALE_MS = 2 * 60 * 60 * 1000;

/** Busy, but long enough ago that it is stuck rather than working. */
function stuck(slot, now) {
  if (!slot.fedAt) return true; // busy with no record of being fed = pre-dates us
  const fed = Date.parse(slot.fedAt);
  return Number.isFinite(fed) && now - fed > STALE_MS;
}

/**
 * @param {Array<{ slot: number, status?: string, fedAt?: string }>} slots
 *        every demo slot with its current status and when it was last fed.
 * @param {number} [now] injectable clock, for the staleness check.
 * @returns {number | null} the slot to feed, or null when all are still busy.
 */
export function chooseSlot(slots, now = Date.now()) {
  const free = (slots ?? []).filter(
    (s) => !(s.status && BUSY.has(s.status)) || stuck(s, now),
  );
  if (free.length === 0) return null;

  // Never fed sorts first; then oldest fedAt. Ties fall back to slot order so
  // the choice is deterministic (ISO timestamps collide at second resolution).
  let best = null;
  for (const s of free) {
    if (best === null) { best = s; continue; }
    const a = s.fedAt ?? '';
    const b = best.fedAt ?? '';
    if (a < b || (a === b && s.slot < best.slot)) best = s;
  }
  return best.slot;
}
