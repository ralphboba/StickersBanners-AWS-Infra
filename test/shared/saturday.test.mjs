// Saturday (Kai, 2026-10-17): FedEx Overnight (Saturday) as an upgrade, only
// Thursday 2:00 PM – Friday 4:00 PM New York time.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { saturdayWindowOpen, orderStage, SATURDAY_SERVICE } from '../../src/shared/order-stage.mjs';
import { stillAllowed } from '../../src/shared/paid-recheck.mjs';
import { makeHandler } from '../../src/functions/order-status-api/routes.mjs';

const at = (iso) => Date.parse(iso);

describe('the window', () => {
  test('Thursday 2 PM to Friday 4 PM, New York time (EDT)', () => {
    assert.equal(saturdayWindowOpen(at('2026-10-15T17:59:00Z')), false);  // Thu 1:59 PM EDT
    assert.equal(saturdayWindowOpen(at('2026-10-15T18:00:00Z')), true);   // Thu 2:00 PM
    assert.equal(saturdayWindowOpen(at('2026-10-16T04:00:00Z')), true);   // Fri 12:00 AM
    assert.equal(saturdayWindowOpen(at('2026-10-16T19:59:00Z')), true);   // Fri 3:59 PM
    assert.equal(saturdayWindowOpen(at('2026-10-16T20:00:00Z')), false);  // Fri 4:00 PM
    assert.equal(saturdayWindowOpen(at('2026-10-14T18:00:00Z')), false);  // Wed
    assert.equal(saturdayWindowOpen(at('2026-10-17T15:00:00Z')), false);  // Sat
  });
  test('the same hours in winter (EST)', () => {
    assert.equal(saturdayWindowOpen(at('2026-12-03T18:59:00Z')), false);  // Thu 1:59 PM EST
    assert.equal(saturdayWindowOpen(at('2026-12-03T19:00:00Z')), true);   // Thu 2:00 PM EST
    assert.equal(saturdayWindowOpen(at('2026-12-04T20:59:00Z')), true);   // Fri 3:59 PM EST
    assert.equal(saturdayWindowOpen(at('2026-12-04T21:00:00Z')), false);  // Fri 4:00 PM EST
  });
});

describe('the options', () => {
  const stage = (method, saturdayOpen) => orderStage({ folderId: '73068', shippingMethod: method, saturdayOpen });
  test('in the window it is the fastest option, after 1-Day', () => {
    assert.deepEqual(stage('FedEx Ground', true).upgradeOptions, ['FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day', SATURDAY_SERVICE]);
    assert.deepEqual(stage('FedEx Ground', false).upgradeOptions, ['FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day']);
  });
  test('a 1-Day order can move up to Saturday in the window; outside it, still the fastest', () => {
    const open = stage('FedEx 1-Day', true);
    assert.deepEqual([open.canUpgrade, open.upgradeTo, open.upgradeOptions], [true, SATURDAY_SERVICE, [SATURDAY_SERVICE]]);
    assert.equal(stage('FedEx 1-Day', false).blockedBy, 'already_fastest');
  });
  test('an order already on Saturday, a pickup, or a closed order: nothing new', () => {
    assert.equal(stage(SATURDAY_SERVICE, true).canUpgrade, false);
    assert.equal(stage('Georgia Warehouse', true).upgradeOptions.length, 0);
    assert.equal(orderStage({ folderId: '3516', shippingMethod: 'FedEx Ground', saturdayOpen: true }).canUpgrade, false);
  });
});

describe('paid after the cutoff', () => {
  const od = { folder_id: 73068, shipping_method: 'FedEx Ground', order_notes: [], shipping: { state: 'GA', country: 'US' }, order_items: [{ name: 'Banner' }] };
  const change = { ref: 'CHG-1', from: 'FedEx Ground', to: SATURDAY_SERVICE };
  test('in the window it is written; after Friday 4 PM it is not, and says why', () => {
    assert.deepEqual(stillAllowed(od, change, { saturdayOpen: true }), { allowed: true });
    const late = stillAllowed(od, change, { saturdayOpen: false });
    assert.equal(late.allowed, false);
    assert.equal(late.reason, 'saturday_closed');
    assert.match(late.label, /Friday 4 PM ET/);
  });
});

describe('the page', () => {
  const URL = 'https://stickersbanners.myshopify.com/1234/orders/abcdef0123456789abcdef?key=k';
  const ROW = { orderName: 'S1', folderId: '73068', orderStatusUrl: URL, shipping: { method: 'FedEx 1-Day', state: 'GA' }, items: [{ name: 'Banner' }] };
  const handler = (open, asked) => makeHandler({
    loadRow: async () => ROW,
    loadShopifyOrder: async () => ({ name: 'S1', id: 'gid://shopify/Order/1', outstandingCents: 0, shippingLines: [{ title: 'FedEx 1-Day' }] }),
    quote: async ({ to }) => { asked.push(to); return { ok: true, final: true, from: 'FedEx 1-Day', to, shippingCents: 3307, taxCents: 198, totalCents: 3505, fromCents: 14879, toCents: 18186 }; },
    estimates: async () => null,
    loadPending: async () => null,
    saturdayOpen: () => open,
  });
  const get = (h) => h({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order', queryStringParameters: { o: 'S1', s: URL } });
  test('in the window a 1-Day order is offered Saturday, priced by Shopify; outside it, nothing to buy', async () => {
    const asked = [];
    const body = JSON.parse((await get(handler(true, asked))).body);
    assert.deepEqual(asked, [SATURDAY_SERVICE]);
    assert.deepEqual(body.shipping.upgrades.map((u) => u.to), [SATURDAY_SERVICE]);
    const none = [];
    await get(handler(false, none));
    assert.deepEqual(none, []);
  });
});
