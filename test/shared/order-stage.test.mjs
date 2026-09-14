// Two things must hold no matter what: an internal folder name never reaches a
// customer, and an order we are unsure about is never sold an upgrade.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { orderStage, nextService, STEPS } from '../../src/shared/order-stage.mjs';
import { FOLDERS } from '../../src/shared/orderdesk-folders.mjs';

describe('the upgrade ladder', () => {
  test('3-Day buys 2-Day, 2-Day buys 1-Day, 1-Day buys nothing', () => {
    assert.deepEqual(nextService('3-Day Shipping'), { from: '3-day Shipping', to: '2-day Shipping', top: false });
    assert.deepEqual(nextService('2-Day Shipping'), { from: '2-day Shipping', to: '1-day Shipping', top: false });
    assert.deepEqual(nextService('1-Day Shipping'), { from: '1-day Shipping', to: null, top: true });
  });

  test('the spellings that actually appear on orders all match', () => {
    for (const m of ['2-day', '2 Day', '2DAY', '2-Day Shipping', 'FedEx 2-day']) {
      assert.equal(nextService(m)?.to, '1-day Shipping', `"${m}" should be a 2-day order`);
    }
    for (const m of ['1-day', 'Overnight', 'FedEx Overnight', '1 Day']) {
      assert.equal(nextService(m)?.top, true, `"${m}" should already be fastest`);
    }
  });

  test('anything off the ladder gets no offer at all', () => {
    for (const m of ['Ground', 'FedEx Ground', 'Local Pickup', 'Saturday Overnight', '', null, undefined]) {
      assert.equal(nextService(m), null, `"${String(m)}" must not be upgradable`);
    }
  });

  test('two notches are never offered — 3-Day cannot reach 1-Day', () => {
    assert.equal(nextService('3-day').to, '2-day Shipping');
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
    assert.equal(s.upgradeTo, '1-day Shipping');
    assert.equal(s.blockedBy, null);
  });

  test('Awaiting Shipment: no, and the reason is the cutoff', () => {
    const s = orderStage({ folderId: '3571', shippingMethod: '2-Day Shipping' });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'shipping');
    assert.equal(s.upgradeTo, null);
  });

  test('already on 1-Day: no, and the reason says so', () => {
    const s = orderStage({ folderId: '674352', shippingMethod: '1-Day Shipping' });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'already_fastest');
  });

  test('Ground in production: no, because Ground is off the ladder', () => {
    const s = orderStage({ folderId: '73068', shippingMethod: 'Ground' });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'service_not_upgradable');
  });

  test('unknown folder: no, whatever the service says', () => {
    const s = orderStage({ folderId: '999999', shippingMethod: '2-Day Shipping' });
    assert.equal(s.canUpgrade, false);
    assert.equal(s.blockedBy, 'unknown_folder');
  });

  test('no folder at all, or no arguments: no', () => {
    assert.equal(orderStage({}).canUpgrade, false);
    assert.equal(orderStage().canUpgrade, false);
  });

  test('a locked folder never offers an upgrade, on any service', () => {
    for (const f of FOLDERS.filter((x) => !x.modifiable)) {
      for (const m of ['3-day', '2-day', '1-day', 'Ground']) {
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
    assert.equal(s.upgradeTo, '1-day Shipping');
  });

  test('each facility keeps its own orders through the ladder', () => {
    const production = { GA: '73068', NJ: '73069', TX: '73070', NV: '674352', CA: '42928' };
    for (const [fac, id] of Object.entries(production)) {
      assert.equal(orderStage({ folderId: id, shippingMethod: '3-day' }).facility, fac);
    }
  });
});

describe('never collide with the legacy bot', () => {
  test('the strings written back match what routing.mjs writes', () => {
    // Same service, same spelling, whichever program set it.
    assert.equal(nextService('3-day').to, '2-day Shipping',
      "must match routing.mjs's expressUpgrade target exactly");
  });

  test('an unrouted 3-day order is NOT sold an upgrade the legacy bot may give free', () => {
    for (const id of ['665685', '653109', '661019', '73066', '73067', '31358']) {
      const s = orderStage({ folderId: id, shippingMethod: '3-day Shipping' });
      assert.equal(s.canUpgrade, false, `folder ${id} must not sell a 3-day upgrade`);
      assert.equal(s.blockedBy, 'awaiting_routing');
    }
  });

  test('once routed, a 3-day order is ours to sell — the bot already decided', () => {
    for (const id of ['73068', '73069', '73070', '674352', '42928']) {
      const s = orderStage({ folderId: id, shippingMethod: '3-day Shipping' });
      assert.equal(s.canUpgrade, true, `folder ${id} should sell the upgrade`);
      assert.equal(s.upgradeTo, '2-day Shipping');
    }
  });

  test('2-day is unaffected — the legacy bot never gives 1-day away', () => {
    assert.equal(orderStage({ folderId: '665685', shippingMethod: '2-day' }).canUpgrade, true);
    assert.equal(orderStage({ folderId: '73068', shippingMethod: '2-day' }).canUpgrade, true);
  });

  test('the guard does not depend on the clock', () => {
    // The legacy cutoff is 3-6pm ET, but the page is opened at any hour and the
    // routing may happen later. Refusing by folder, not by time, holds always.
    const a = orderStage({ folderId: '665685', shippingMethod: '3-day' });
    const b = orderStage({ folderId: '665685', shippingMethod: '3-day' });
    assert.deepEqual(a, b);
    assert.equal(a.canUpgrade, false);
  });
});
