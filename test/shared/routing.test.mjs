// Facility routing — run with `npm run test:shared`.
//
// Covers legacy getState + determineProduction in order: pickup keywords,
// the 3-6pm ET express cutoff, the state lists, then the ZIP fallback.

import test from 'node:test';
import assert from 'node:assert/strict';

import { routeOrder, transportFor, easternHour } from '../../src/shared/routing.mjs';

/** A Date at the given America/New_York hour on a winter (EST) day. */
const etHour = (h) => new Date(Date.UTC(2026, 0, 15, h + 5, 0));
const route = (shipping, opts = {}) => routeOrder(shipping, { now: etHour(10), ...opts });

// --- state lists (Linh's, as sent to Kai) ----------------------------------

test('state lists route as Linh specified', () => {
  const cases = { GA: 'GA', FL: 'GA', VA: 'GA', NY: 'NJ', MD: 'NJ', PA: 'NJ', TX: 'TX', MN: 'TX', AZ: 'NV', WA: 'NV' };
  for (const [state, facility] of Object.entries(cases)) {
    assert.equal(route({ state, method: 'FedEx Ground' }).facility, facility, state);
  }
});

test('CA ships via Drive, everything else via FTP', () => {
  assert.equal(transportFor('CA'), 'GDRIVE');
  for (const f of ['GA', 'NJ', 'TX', 'NV']) assert.equal(transportFor(f), 'FTP');
});

// --- ZIP fallback (legacy checkNVCA) ---------------------------------------

test('a CA address falls to the zip dictionaries', () => {
  assert.equal(route({ state: 'CA', postalCode: '90001', method: 'Ground' }).facility, 'NV');
  assert.equal(route({ state: 'CA', postalCode: '90085', method: 'Ground' }).facility, 'CA');
});

test('a zip in neither dictionary is UNROUTED, not assumed CA', () => {
  // Legacy checkNVCA returns false here; the order is held for manual assignment.
  assert.equal(route({ state: 'CA', postalCode: '99999', method: 'Ground' }).facility, 'UNROUTED');
  assert.equal(route({ state: 'AK', postalCode: '99501', method: 'Ground' }).facility, 'UNROUTED');
});

// --- pickup keywords -------------------------------------------------------

test('local pickup beats the shipping address', () => {
  // Shipping to NY, collected in Duluth GA -> GA.
  assert.equal(route({ state: 'NY', method: 'Local Pickup - Duluth' }).facility, 'GA');
  assert.equal(route({ state: 'NY', method: 'Pickup Carrollton' }).facility, 'TX');
  assert.equal(route({ state: 'NY', method: 'Pickup Nevada' }).facility, 'NV');
});

test('KNOWN LEGACY QUIRK: city names containing "ga" match GA first', () => {
  // Not a bug in this port — legacy has the same keyword lists in the same
  // order, GA is checked first, and its list contains the bare 'ga'. Both the
  // CA and NV facility cities collide with it:
  //     "gardena" -> GA        "vegas" -> GA
  // Pinned so nobody "fixes" it by accident; changing it changes where real
  // orders ship from. Raised with Linh.
  assert.equal(route({ state: 'NY', method: 'Local Pickup Gardena' }).facility, 'GA');
  assert.equal(route({ state: 'NY', method: 'Pickup Las Vegas' }).facility, 'GA');
  // Spellings without "ga" still reach the right facility.
  assert.equal(route({ state: 'NY', method: 'Pickup California' }).facility, 'CA');
  assert.equal(route({ state: 'NY', method: 'Pickup Nevada' }).facility, 'NV');
});

// --- express cutoff --------------------------------------------------------

test('1-day and 2-day inside the 3-6pm ET window go to NV', () => {
  for (const method of ['Overnight', '1-day Shipping', '2-day Shipping', '2day']) {
    assert.equal(routeOrder({ state: 'GA', method }, { now: etHour(16) }).facility, 'NV', method);
  }
});

test('outside the window express routes normally', () => {
  for (const h of [10, 14, 19, 23]) {
    assert.equal(routeOrder({ state: 'GA', method: '2-day Shipping' }, { now: etHour(h) }).facility, 'GA', `${h}:00`);
  }
});

test('3-day inside the window is upgraded to 2-day and still routes by state', () => {
  const r = routeOrder({ state: 'GA', method: '3-day Shipping' }, { now: etHour(16) });
  assert.equal(r.facility, 'GA');
  assert.deepEqual(r.expressUpgrade, { to: '2-day Shipping', note: '3-day to 2-day after 3PM cutoff' });
});

test('3-day outside the window is not upgraded', () => {
  assert.equal(routeOrder({ state: 'GA', method: '3-day Shipping' }, { now: etHour(10) }).expressUpgrade, undefined);
});

test('the cutoff boundaries match legacy (>=15 and <=18)', () => {
  const at = (h) => routeOrder({ state: 'GA', method: '2-day Shipping' }, { now: etHour(h) }).facility;
  assert.equal(at(14), 'GA');
  assert.equal(at(15), 'NV');
  assert.equal(at(18), 'NV');
  assert.equal(at(19), 'GA');
});

// --- see-thru --------------------------------------------------------------

test('see-thru is forced to NV once the state lists miss', () => {
  assert.equal(route({ state: 'CA', postalCode: '90085', method: 'Ground' }, { seeThru: true }).facility, 'NV');
  // A state on a list still wins — legacy checks the lists first.
  assert.equal(route({ state: 'NY', method: 'Ground' }, { seeThru: true }).facility, 'NJ');
});

test('see-thru cannot be picked up from CA', () => {
  const r = route({ state: 'NY', method: 'Pickup California' }, { seeThru: true });
  assert.equal(r.facility, 'UNROUTED');
});

// --- misc ------------------------------------------------------------------

test('easternHour reads the hour in America/New_York', () => {
  assert.equal(easternHour(etHour(16)), 16);
  assert.equal(easternHour(etHour(0)), 0);
});
