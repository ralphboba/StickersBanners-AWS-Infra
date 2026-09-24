// Danny's rules. Each one exists because saying yes wrongly costs a refund and
// a phone call, so the tests lean on the refusals.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPoBox, isNoShipDestination, isB2Sign, ineligibleReason, NO_SHIP_REGIONS,
} from '../../src/shared/upgrade-eligibility.mjs';
import { orderStage } from '../../src/shared/order-stage.mjs';

describe('destinations the store does not ship to', () => {
  test('the four Danny named', () => {
    for (const s of ['HI', 'AK', 'PR', 'VI']) {
      assert.equal(isNoShipDestination({ state: s }), true, s);
    }
  });

  test('military addresses too — inferred, and refused on purpose', () => {
    for (const s of ['AA', 'AE', 'AP']) {
      assert.equal(isNoShipDestination({ state: s }), true, s);
      assert.ok(NO_SHIP_REGIONS.has(s));
    }
  });

  test('spelled out, and in the country field', () => {
    assert.equal(isNoShipDestination({ state: 'Hawaii' }), true);
    assert.equal(isNoShipDestination({ state: 'hawaii' }), true);
    assert.equal(isNoShipDestination({ country: 'Puerto Rico' }), true);
  });

  test('the states we do ship to are not caught', () => {
    for (const s of ['GA', 'NJ', 'TX', 'NV', 'CA', 'NY', 'VA', 'PA', 'VT', 'AL', 'AR']) {
      assert.equal(isNoShipDestination({ state: s }), false, `${s} must be allowed`);
    }
  });

  test('VA is not VI, and AL is not AK', () => {
    // The two-letter codes are one keystroke apart from ones we refuse.
    assert.equal(isNoShipDestination({ state: 'VA' }), false);
    assert.equal(isNoShipDestination({ state: 'AL' }), false);
  });

  test('nothing given is not a refusal by itself', () => {
    assert.equal(isNoShipDestination({}), false);
    assert.equal(isNoShipDestination(), false);
  });
});

describe('PO boxes', () => {
  test('the spellings that turn up on real orders', () => {
    for (const a of ['PO Box 512', 'P.O. Box 512', 'p o box 512', 'POST OFFICE BOX 9',
                     'Postal Box 4', 'Suite 2, PO Box 77']) {
      assert.equal(isPoBox(a), true, a);
    }
  });

  test('a street that merely contains "post" or "box" is fine', () => {
    for (const a of ['5 Post Road', '12 Boxwood Lane', '100 Post Office Road',
                     '8 Boxer St', '44 Postgate Ave']) {
      assert.equal(isPoBox(a), false, `${a} must not be read as a PO box`);
    }
  });

  test('the second address line is checked as well', () => {
    assert.equal(isPoBox('184 Peachtree St NW', 'PO Box 3'), true);
  });

  test('empty lines are not PO boxes', () => {
    assert.equal(isPoBox('', null, undefined), false);
  });
});

describe('B2SIGN orders', () => {
  test('supplier products are caught by name', () => {
    for (const n of ['12oz Canvas Wrap 24x36', 'Yard Sign 18x24', "10ft Tent Canopy",
                     '15 ft Tent', 'Tent Wall (full)']) {
      assert.equal(isB2Sign([{ name: n }]), true, n);
    }
  });

  test('our own products are not', () => {
    for (const n of ['Custom Vinyl Banner', 'Oval Stickers', 'Mesh Banner', 'Pop Up Retractable']) {
      assert.equal(isB2Sign([{ name: n }]), false, n);
    }
  });

  test('one supplier item in a mixed order is enough to refuse', () => {
    assert.equal(isB2Sign([{ name: 'Vinyl Banner' }, { name: 'Yard Sign 18x24' }]), true);
  });

  test('no items is not a supplier order', () => {
    assert.equal(isB2Sign([]), false);
    assert.equal(isB2Sign(), false);
  });
});

describe('the reasons compose in the right order', () => {
  const ok = { state: 'GA', street: '184 Peachtree St NW' };

  test('a clean order objects to nothing', () => {
    assert.equal(ineligibleReason({ shipping: ok, items: [{ name: 'Vinyl Banner' }] }), null);
  });

  test('a supplier order is named as such even when the address is also bad', () => {
    // "This is made by a partner" is the more useful thing to tell someone than
    // "we don't ship there", because it is the one a phone call can resolve.
    const r = ineligibleReason({ shipping: { state: 'HI' }, items: [{ name: 'Yard Sign' }] });
    assert.deepEqual(r, { blockedBy: 'supplier_order' });
  });

  test('each rule reports itself', () => {
    assert.deepEqual(ineligibleReason({ shipping: { state: 'HI' } }), { blockedBy: 'destination' });
    assert.deepEqual(ineligibleReason({ shipping: { state: 'GA', street: 'PO Box 1' } }),
      { blockedBy: 'po_box' });
  });
});

describe('through orderStage', () => {
  const inProduction = { folderId: '73068', shippingMethod: 'FedEx 2-Days' };

  test('a normal order in production can still upgrade', () => {
    const s = orderStage({ ...inProduction, shipping: { state: 'GA', street: '1 Main St' },
      items: [{ name: 'Vinyl Banner' }] });
    assert.equal(s.canUpgrade, true);
  });

  test('Hawaii cannot, wherever the order sits', () => {
    const s = orderStage({ ...inProduction, shipping: { state: 'HI', street: '1 Main St' } });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'destination');
  });

  test('a PO box cannot', () => {
    const s = orderStage({ ...inProduction, shipping: { state: 'GA', street: 'PO Box 9' } });
    assert.equal(s.blockedBy, 'po_box');
  });

  test('a B2SIGN order cannot, and is not told it is already fastest', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: 'FedEx 1-Day',
      shipping: { state: 'GA' }, items: [{ name: 'Yard Sign 18x24' }] });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'supplier_order');
  });

  test('the cutoff still wins over everything', () => {
    const s = orderStage({ folderId: '3571', shippingMethod: 'FedEx 2-Days',
      shipping: { state: 'HI' }, items: [{ name: 'Yard Sign' }] });
    assert.equal(s.blockedBy, 'shipping');
  });

  test('an order with no shipping detail is unaffected by these rules', () => {
    // Older mirror rows predate the street being stored; they must not all
    // suddenly become ineligible.
    const s = orderStage(inProduction);
    assert.equal(s.canUpgrade, true);
  });
});
