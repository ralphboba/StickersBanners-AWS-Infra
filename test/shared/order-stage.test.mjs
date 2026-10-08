// Two things must hold no matter what: an internal folder name never reaches a
// customer, and an order we are unsure about is never sold an upgrade.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { orderStage, nextService, isPickup, STEPS, DELIVERY_OPTIONS } from '../../src/shared/order-stage.mjs';
import { FOLDERS } from '../../src/shared/orderdesk-folders.mjs';

describe('the upgrade ladder', () => {
  test('3-Day buys 2-Day, 2-Day buys 1-Day, 1-Day buys nothing', () => {
    assert.deepEqual(nextService('3-Day Shipping'), { from: 'FedEx 3-Days', to: 'FedEx 2-Days', top: false, options: ['FedEx 2-Days', 'FedEx 1-Day'] });
    assert.deepEqual(nextService('2-Day Shipping'), { from: 'FedEx 2-Days', to: 'FedEx 1-Day', top: false, options: ['FedEx 1-Day'] });
    assert.deepEqual(nextService('1-Day Shipping'), { from: 'FedEx 1-Day', to: null, top: true, options: [] });
  });

  test('every faster service is offered, nearest first (Kai, 2026-10-01)', () => {
    assert.deepEqual(nextService('FedEx Ground').options, ['FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day']);
  });

  test('the spellings that actually appear on orders all match', () => {
    for (const m of ['2-day', '2 Day', '2DAY', '2-Day Shipping', 'FedEx 2-day']) {
      assert.equal(nextService(m)?.to, 'FedEx 1-Day', `"${m}" should be a 2-day order`);
    }
    for (const m of ['1-day', 'Overnight', 'FedEx Overnight', '1 Day']) {
      assert.equal(nextService(m)?.top, true, `"${m}" should already be fastest`);
    }
  });

  test('Ground is the bottom rung again (Kai, 2026-09-28)', () => {
    assert.equal(nextService('FedEx Ground').to, 'FedEx 3-Days');
    assert.equal(nextService('Ground').to, 'FedEx 3-Days');
    assert.equal(nextService('FedEx GROUND').to, 'FedEx 3-Days');
  });

  test('anything off the ladder gets no offer at all', () => {
    for (const m of ['Saturday Overnight', 'Sat Overnight', '', null, undefined]) {
      assert.equal(nextService(m), null, `"${String(m)}" must not be upgradable`);
    }
  });

  test('two notches are never offered', () => {
    assert.equal(nextService('3-day').to, 'FedEx 2-Days');
    assert.equal(nextService('FedEx Ground').to, 'FedEx 3-Days', 'Ground must not jump past 3-Days');
  });
});

describe('the customer never sees an internal name', () => {
  test('no stage label leaks a folder name', () => {
    const names = FOLDERS.map((f) => f.name.toLowerCase());
    for (const f of FOLDERS) {
      const { label } = orderStage({ folderId: f.id, shippingMethod: '2-day' });
      assert.ok(!names.includes(label.toLowerCase()), `"${label}" is a folder name`);
      assert.ok(!/missing|corrupt|manual|admin|qts|pending/i.test(label),
        `"${label}" reads like an internal state`);
    }
  });

  test('an unknown folder gets a vague, calm label — not an error', () => {
    const s = orderStage({ folderId: '999999', shippingMethod: '2-day' });
    assert.equal(s.label, 'Being prepared');
    assert.equal(s.known, false);
    assert.ok(STEPS[s.step], 'step must still index into the tracker');
  });

  test('every stage maps to a real step on the tracker', () => {
    for (const f of FOLDERS) {
      const { step } = orderStage({ folderId: f.id });
      assert.ok(Number.isInteger(step) && STEPS[step], `${f.name} -> bad step ${step}`);
    }
  });
});

describe('canUpgrade', () => {
  test('in production on 2-Day: yes, and the offer is 1-Day', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: '2-Day Shipping' });
    assert.equal(s.canUpgrade, true);
    assert.equal(s.upgradeTo, 'FedEx 1-Day');
    assert.equal(s.blockedBy, null);
  });

  test('Awaiting Shipment on Ground: yes — only Completed Orders is closed (Kai, 2026-10-08)', () => {
    const s = orderStage({ folderId: '3571', shippingMethod: 'FedEx Ground' });
    assert.equal(s.canUpgrade, true);
    assert.equal(s.blockedBy, null);
  });

  test('already on 1-Day: no, and the reason says so', () => {
    const s = orderStage({ folderId: '674352', shippingMethod: '1-Day Shipping' });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'already_fastest');
  });

  test('Ground in production: yes, to 3-Days', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: 'FedEx Ground' });
    assert.equal(s.canUpgrade, true);
    assert.equal(s.upgradeTo, 'FedEx 3-Days');
  });

  test('Saturday Overnight in production: no, it is off the ladder', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: 'Saturday Overnight' });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'service_not_upgradable');
  });

  test('unknown folder: open, like every folder but Completed Orders', () => {
    const s = orderStage({ folderId: '999999', shippingMethod: 'FedEx Ground' });
    assert.equal(s.canUpgrade, true);
  });

  test('no folder at all, or no arguments: no', () => {
    assert.equal(orderStage({}).canUpgrade, false);
    assert.equal(orderStage().canUpgrade, false);
  });

  test('a closed folder never offers an upgrade, on any service', () => {
    for (const f of FOLDERS.filter((x) => x.window === 'closed')) {
      for (const m of ['3-day', '2-day', '1-day', 'FedEx Ground']) {
        assert.equal(orderStage({ folderId: f.id, shippingMethod: m }).canUpgrade, false,
          `${f.name} + ${m} must be refused`);
      }
    }
  });
});

describe('the facility never changes on an upgrade', () => {
  test('an order upgraded in GA is still reported as GA', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: '2-Day Shipping' });
    assert.equal(s.facility, 'GA', 'upgrading must not re-route to NV');
    assert.equal(s.upgradeTo, 'FedEx 1-Day');
  });

  test('each facility keeps its own orders through the ladder', () => {
    const production = { GA: '73068', NJ: '73069', TX: '73070', NV: '674352', CA: '42928' };
    for (const [fac, id] of Object.entries(production)) {
      assert.equal(orderStage({ folderId: id, shippingMethod: '3-day' }).facility, fac);
    }
  });
});

describe('never collide with the legacy bot', () => {
  test('the exact strings the live store uses, plural and all', () => {
    assert.equal(nextService('FedEx 3-Days').to, 'FedEx 2-Days');
    assert.equal(nextService('FedEx 2-Days').to, 'FedEx 1-Day', 'one day is singular');
    assert.equal(nextService('FedEx 1-Day').top, true);
  });

  test('reading tolerates the singular too, in case an order carries it', () => {
    assert.equal(nextService('FedEx 2-Day').to, 'FedEx 1-Day');
    assert.equal(nextService('2-day Shipping').to, 'FedEx 1-Day');
  });

  test('the strings written back match what routing.mjs writes', () => {
    // Same service, same spelling, whichever program set it.
    // The observed spelling on a real order (S60338) is 'FedEx 1-Day', so the
    // ladder follows that shape rather than routing.mjs's '2-day Shipping'.
    assert.equal(nextService('1-day').from, 'FedEx 1-Day');
  });

  test('a 3-day order is upgradable in every folder, routed or not (Kai, 2026-10-08)', () => {
    for (const id of ['665685', '651474', '653109', '661019', '73066', '73067', '31358',
                      '73068', '73069', '73070', '674352', '42928', '3571']) {
      const s = orderStage({ folderId: id, shippingMethod: 'FedEx 3-Days' });
      assert.equal(s.canUpgrade, true, `folder ${id}`);
      assert.deepEqual(s.upgradeOptions, ['FedEx 2-Days', 'FedEx 1-Day']);
    }
  });

  test('2-day is unaffected — the legacy bot never gives 1-day away', () => {
    assert.equal(orderStage({ folderId: '665685', shippingMethod: '2-day' }).canUpgrade, true);
    assert.equal(orderStage({ folderId: '73068', shippingMethod: '2-day' }).canUpgrade, true);
  });

});

describe('the methods live orders actually carry', () => {
  // Sampled from the store on 2026-09-28: Ground 70%, warehouse pickup 18%,
  // 2-Days 10%, 1-Day 2%. Every one of these must land somewhere deliberate.
  const LIVE = [
    'FedEx Ground', 'FedEx 2-Days', 'FedEx 2-days', 'FedEx 1-Day',
    'Georgia Warehouse', 'New Jersey Warehouse', 'Texas Warehouse',
  ];

  test('none of them falls through unrecognised', () => {
    for (const m of LIVE) {
      const known = nextService(m) !== null || isPickup(m);
      assert.ok(known, `"${m}" is neither on the ladder nor recognised as pickup`);
    }
  });

  test('both spellings of 2-Days read the same', () => {
    assert.deepEqual(nextService('FedEx 2-Days'), nextService('FedEx 2-days'),
      'the store holds both; reading must not care');
  });

  test('pickup is spelled as the warehouse, not as "pickup"', () => {
    for (const m of ['Georgia Warehouse', 'New Jersey Warehouse', 'Texas Warehouse']) {
      assert.equal(isPickup(m), true, m);
      assert.equal(nextService(m), null, `${m} must not be sold a speed upgrade`);
    }
  });

  test('and "pickup" still works, for anywhere that spells it that way', () => {
    for (const m of ['Local Pickup', 'Pick Up', 'pick-up']) assert.equal(isPickup(m), true, m);
  });

  test('a shipping service is never mistaken for pickup', () => {
    for (const m of ['FedEx Ground', 'FedEx 1-Day', 'FedEx 2-Days']) {
      assert.equal(isPickup(m), false, m);
    }
  });

});

describe('pickup -> delivery conversion', () => {
  // Danny: "customers should have the ability to upgrade to delivery."
  // Kai, 2026-09-28: still allowed after production has finished.

  test('offered in the open and the restricted window', () => {
    for (const id of ['73068', '31301', '3571']) {
      const s = orderStage({ folderId: id, shippingMethod: 'Georgia Warehouse' });
      assert.equal(s.canConvert, true, id);
      assert.equal(s.blockedBy, null, id);
      assert.equal(s.canUpgrade, false, `${id}: a conversion is not a speed upgrade`);
      assert.equal(s.upgradeTo, null, id);
    }
  });

  test('to all four sellable services, never Saturday Overnight', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: 'Texas Warehouse' });
    assert.deepEqual(s.convertTo, ['FedEx Ground', 'FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day']);
    assert.ok(!s.convertTo.some((x) => /saturday/i.test(x)));
    assert.deepEqual([...DELIVERY_OPTIONS], s.convertTo);
  });

  test('the returned list is a copy, not the frozen original', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: 'Texas Warehouse' });
    s.convertTo.pop();
    assert.equal(DELIVERY_OPTIONS.length, 4);
  });

  test('refused only once the order is completed; an unknown folder converts', () => {
    const c = orderStage({ folderId: '3516', shippingMethod: 'Georgia Warehouse' });
    assert.equal(c.blockedBy, 'completed_pickup');
    assert.deepEqual(c.convertTo, []);
    assert.equal(orderStage({ folderId: '999999', shippingMethod: 'Georgia Warehouse' }).canConvert, true);
    assert.equal(orderStage({ folderId: '52437', shippingMethod: 'New Jersey Warehouse' }).canConvert, true);
  });

  test('refused for a B2SIGN order, as an upgrade would be', () => {
    const s = orderStage({
      folderId: '73068', shippingMethod: 'Georgia Warehouse',
      items: [{ name: 'Yard Sign 18x24' }],
    });
    assert.equal(s.canConvert, false);
    assert.equal(s.blockedBy, 'supplier_order');
  });

  test('the pickup address is not judged: there is no delivery address yet', () => {
    // A pickup order may carry the customer's billing address in shipping,
    // including a PO box. The address that matters is the one typed at quote time.
    const s = orderStage({
      folderId: '73068', shippingMethod: 'Georgia Warehouse',
      shipping: { street: 'PO Box 12', state: 'HI', country: 'US' },
    });
    assert.equal(s.canConvert, true);
  });

  test('a delivery order is never offered a conversion', () => {
    for (const m of ['FedEx Ground', 'FedEx 2-Days', 'FedEx 1-Day']) {
      const s = orderStage({ folderId: '73068', shippingMethod: m });
      assert.equal(s.canConvert, false, m);
      assert.deepEqual(s.convertTo, [], m);
    }
  });
});

describe('the restricted window, service by service', () => {
  // Kai, 2026-09-28: once production is finished, express may still move up
  // and a pickup may still become a delivery, but Ground may not.
  const AW = '3571';   // GA Awaiting Shipment
  const PROD = '73068';

  test('Ground: open before and after production', () => {
    assert.equal(orderStage({ folderId: PROD, shippingMethod: 'FedEx Ground' }).canUpgrade, true);
    assert.equal(orderStage({ folderId: AW, shippingMethod: 'FedEx Ground' }).canUpgrade, true);
  });

  test('express: unaffected by the window', () => {
    for (const m of ['FedEx 3-Days', 'FedEx 2-Days', 'FedEx 2-days']) {
      assert.equal(orderStage({ folderId: PROD, shippingMethod: m }).canUpgrade, true, `open ${m}`);
      assert.equal(orderStage({ folderId: AW, shippingMethod: m }).canUpgrade, true, `restricted ${m}`);
    }
  });

  test('1-Day is still the top, in either window', () => {
    for (const id of [PROD, AW]) {
      assert.equal(orderStage({ folderId: id, shippingMethod: 'FedEx 1-Day' }).blockedBy,
        'already_fastest', id);
    }
  });

  test('nothing at all once the order is completed', () => {
    for (const m of ['FedEx Ground', 'FedEx 2-Days', 'Georgia Warehouse']) {
      const s = orderStage({ folderId: '3516', shippingMethod: m });
      assert.equal(s.window, 'closed');
      assert.equal(s.canUpgrade, false, m);
    }
  });

  test('the window is reported, so the page can word the refusal', () => {
    assert.equal(orderStage({ folderId: PROD, shippingMethod: 'FedEx Ground' }).window, 'open');
    assert.equal(orderStage({ folderId: AW, shippingMethod: 'FedEx Ground' }).window, 'open');
    assert.equal(orderStage({ folderId: '3516' }).window, 'closed');
  });
});

describe('sticker orders', () => {
  test('no upgrade and no conversion', () => {
    const items = [{ name: 'Round Stickers' }];
    const up = orderStage({ folderId: '73068', shippingMethod: 'FedEx Ground', items });
    assert.equal(up.canUpgrade, false);
    assert.equal(up.blockedBy, 'sticker_order');
    const pick = orderStage({ folderId: '73068', shippingMethod: 'Georgia Warehouse', items });
    assert.equal(pick.canConvert, false);
    assert.equal(pick.blockedBy, 'sticker_order');
  });
});
