import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { stillAllowed } from '../../src/shared/paid-recheck.mjs';

const od = (over = {}) => ({ folder_id: 73068, shipping_method: 'FedEx Ground', order_notes: [],
  shipping: { address1: '1 Main', state: 'GA', country: 'US' }, order_items: [{ name: 'X-Banner' }], ...over });
const CHANGE = { ref: 'CHG-1', to: 'FedEx 3-Days' };

describe('paid-time re-check', () => {
  test('still in production: allowed', () => {
    assert.deepEqual(stillAllowed(od(), CHANGE), { allowed: true });
  });
  test('Ground reached Awaiting Shipment while the customer was paying: still applied (only Completed is closed)', () => {
    assert.equal(stillAllowed(od({ folder_id: 3571 }), CHANGE).allowed, true);
  });
  test('Completed: refused, with the stage for the alert', () => {
    const r = stillAllowed(od({ folder_id: 3516 }), CHANGE);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'shipping');
    assert.ok(r.label);
  });
  test('express in Awaiting Shipment is still fine', () => {
    assert.equal(stillAllowed(od({ folder_id: 3571, shipping_method: 'FedEx 2-Days' }), { ref: 'C', to: 'FedEx 1-Day' }).allowed, true);
  });
  test('someone already changed the service by hand: refused', () => {
    assert.equal(stillAllowed(od({ shipping_method: 'FedEx 2-Days' }), CHANGE).allowed, false);
  });
  test('pickup conversion checks the conversion list', () => {
    assert.equal(stillAllowed(od({ shipping_method: 'Georgia Warehouse' }), CHANGE).allowed, true);
    assert.equal(stillAllowed(od({ shipping_method: 'Georgia Warehouse', folder_id: 3516 }), CHANGE).allowed, false);
  });
  test('already written (a repeat webhook) is allowed through to the duplicate guard', () => {
    const done = od({ folder_id: 3516, shipping_method: 'FedEx 3-Days',
      order_notes: [{ content: 'Shipping upgraded FedEx Ground -> FedEx 3-Days by customer, +$61.06 (CHG-1)' }] });
    assert.deepEqual(stillAllowed(done, CHANGE), { allowed: true });
  });
  test('an unknown folder is open', () => {
    assert.equal(stillAllowed(od({ folder_id: 999999 }), CHANGE).allowed, true);
  });
});
