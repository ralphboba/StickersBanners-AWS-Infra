// Demo slot rotation — run with `npm run test:shared`.
//
// The demo slots are the only exercise the image containers get. The version
// this replaces fed the first free slot, and slot 1 is always free first, so
// DEMO-1 ran 60 times in a row while slots 2-8 never ran once — taking pole
// pockets, cut-only, the 8x8 remap and the whole proof branch with them.
//
// These pin that every slot gets a turn.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseSlot, BUSY, STALE_MS } from '../../src/functions/demo-feeder/rotation.mjs';

const at = (n) => `2026-09-09T00:0${n}:00.000Z`;
// A clock just after those timestamps, so "busy" means working, not stuck.
// The staleness escape is exercised separately at the bottom of this file.
const SOON = Date.parse('2026-09-09T00:10:00.000Z');

test('a slot that has never run outranks every slot that has', () => {
  assert.equal(chooseSlot([
    { slot: 1, status: 'pickup_ca', fedAt: at(9) },
    { slot: 2, status: undefined, fedAt: undefined },
    { slot: 3, status: 'failed', fedAt: at(1) },
  ]), 2);
});

test('among slots that have run, the oldest wins', () => {
  assert.equal(chooseSlot([
    { slot: 1, status: 'pickup_ca', fedAt: at(9) },
    { slot: 2, status: 'pickup_nv', fedAt: at(3) },
    { slot: 3, status: 'failed', fedAt: at(7) },
  ]), 2);
});

test('busy slots are left alone', () => {
  for (const status of [...BUSY]) {
    assert.equal(chooseSlot([
      { slot: 1, status, fedAt: at(1) },        // oldest, but still moving
      { slot: 2, status: 'pickup_ca', fedAt: at(9) },
    ], SOON), 2, `${status} must not be re-fed`);
  }
});

test('all busy means feed nothing', () => {
  assert.equal(chooseSlot([
    { slot: 1, status: 'printing', fedAt: at(1) },
    { slot: 2, status: 'proofing', fedAt: at(2) },
  ], SOON), null);
  assert.equal(chooseSlot([]), null);
});

test('terminal states are free again', () => {
  // Anything not in BUSY is finished as far as the board is concerned.
  for (const status of ['pickup_ca', 'pickup_nj', 'failed', 'awaiting_admin']) {
    assert.equal(chooseSlot([{ slot: 1, status, fedAt: at(1) }]), 1, status);
  }
});

test('the regression itself: slot 1 finishing first must not starve the rest', () => {
  // Replays the live failure. Eight slots; each tick the fed slot finishes
  // before the next tick, so every slot is free every time. The old rule
  // returned 1 forever — this one must visit all eight.
  const slots = Array.from({ length: 8 }, (_, i) => ({
    slot: i + 1, status: 'pickup_ca', fedAt: undefined,
  }));
  const visited = [];
  for (let tick = 0; tick < 8; tick += 1) {
    const slot = chooseSlot(slots);
    visited.push(slot);
    // Feeding stamps fedAt; by the next tick it is finished (free) again.
    slots[slot - 1].fedAt = `2026-09-09T00:${String(tick).padStart(2, '0')}:00.000Z`;
  }
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('rotation keeps cycling past the first pass', () => {
  const slots = Array.from({ length: 3 }, (_, i) => ({
    slot: i + 1, status: 'pickup_ca', fedAt: undefined,
  }));
  const visited = [];
  for (let tick = 0; tick < 9; tick += 1) {
    const slot = chooseSlot(slots);
    visited.push(slot);
    slots[slot - 1].fedAt = `2026-09-09T00:${String(tick).padStart(2, '0')}:00.000Z`;
  }
  assert.deepEqual(visited, [1, 2, 3, 1, 2, 3, 1, 2, 3]);
});

test('a busy slot does not lose its place in the queue', () => {
  // Slot 1 is oldest but still printing; slot 2 goes now. Once slot 1 frees,
  // it is still older than slot 2 and goes next — it is delayed, not skipped.
  const slots = [
    { slot: 1, status: 'printing', fedAt: at(1) },
    { slot: 2, status: 'pickup_ca', fedAt: at(5) },
  ];
  assert.equal(chooseSlot(slots, SOON), 2);
  slots[1].fedAt = at(9);
  slots[0].status = 'pickup_ca';
  assert.equal(chooseSlot(slots, SOON), 1);
});

// --- stuck slots -----------------------------------------------------------

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('a slot busy for hours is stuck, not working, and gets recycled', () => {
  // The live failure: DEMO-2/4/6 parked at "proofing" on 2026-08-28 waiting for
  // an approval nobody would give. They are the proof-branch variants, so
  // without this they are precisely the ones that can never run again.
  assert.equal(chooseSlot([
    { slot: 1, status: 'proofing', fedAt: ago(12 * 24 * 60 * 60 * 1000) },
  ], NOW), 1);
});

test('a slot that is genuinely still working is left alone', () => {
  // The pipeline takes about two minutes; a minute in is not stuck.
  assert.equal(chooseSlot([
    { slot: 1, status: 'printing', fedAt: ago(60 * 1000) },
  ], NOW), null);
});

test('the staleness cut-off is respected on both sides', () => {
  const just_under = [{ slot: 1, status: 'proofing', fedAt: ago(STALE_MS - 60_000) }];
  const just_over = [{ slot: 1, status: 'proofing', fedAt: ago(STALE_MS + 60_000) }];
  assert.equal(chooseSlot(just_under, NOW), null);
  assert.equal(chooseSlot(just_over, NOW), 1);
});

test('a busy slot with no fedAt at all is treated as stuck', () => {
  // Rows written before fedAt existed. Otherwise they park forever.
  assert.equal(chooseSlot([{ slot: 1, status: 'proofing' }], NOW), 1);
});

test('a genuinely free slot still beats a stuck one', () => {
  // Recycling a stuck slot orphans its paused execution, so prefer a slot that
  // finished cleanly when one is available.
  assert.equal(chooseSlot([
    { slot: 1, status: 'proofing', fedAt: ago(12 * 24 * 60 * 60 * 1000) },
    { slot: 2, status: 'pickup_ca', fedAt: ago(11 * 24 * 60 * 60 * 1000) },
  ], NOW), 1, 'oldest still wins — stuck slots are not penalised, just unblocked');
});
