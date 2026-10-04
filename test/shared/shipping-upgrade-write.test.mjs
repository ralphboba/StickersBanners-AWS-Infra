// This is the one function in the project that changes what an order is worth.
// The tests are mostly about the ways it must REFUSE.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { applyShippingUpgrade, upgradeAlreadyApplied } from '../../src/shared/orderdesk-write.mjs';

afterEach(() => { delete process.env.ORDERDESK_UPGRADE_WRITES; delete process.env.ORDERDESK_WRITES; });

/** A fake OrderDesk: records what it was asked to do, replies how you say. */
function fakeOrderDesk(order, { getStatus = 200, putStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body) : null });
    if ((init.method ?? 'GET') === 'GET') {
      return { ok: getStatus === 200, status: getStatus, json: async () => ({ order }), text: async () => 'err' };
    }
    return { ok: putStatus === 200, status: putStatus, json: async () => ({}), text: async () => 'err' };
  };
  return { fetchImpl, calls, put: () => calls.find((c) => c.method === 'PUT') };
}

const ORDER = {
  id: '555', shipping_method: 'FedEx 2-Days',
  order_total: '278.11', shipping_total: '128.11', tax_total: '0.00',
  order_notes: [{ username: 'staff', content: 'printed' }],
  customer: { name: 'keep me' },
};

const ARGS = {
  orderDeskId: '555', orderName: 'S59131', toMethod: 'FedEx 1-Day',
  amount: 33.96, invoiceRef: 'D169', storeId: 's', apiKey: 'k',
};

describe('refuses unless everything is right', () => {
  test('switch off: nothing is sent, and the intent is reported', async () => {
    const od = fakeOrderDesk(ORDER);
    const r = await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, false);
    assert.equal(r.skipped, 'disabled');
    assert.equal(od.calls.length, 0, 'must not even read OrderDesk');
    assert.equal(r.intent.amount, '33.96');
  });

  test('the OTHER switch does not arm this one', async () => {
    process.env.ORDERDESK_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    const r = await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal(r.skipped, 'disabled');
    assert.equal(od.calls.length, 0);
  });

  test('a synthetic order is refused even with the switch armed', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    for (const name of ['DEMO-1', 'ZZ-4']) {
      const r = await applyShippingUpgrade({ ...ARGS, orderName: name, fetchImpl: od.fetchImpl });
      assert.equal(r.skipped, 'synthetic');
    }
    assert.equal(od.calls.length, 0);
  });

  test('a zero or negative amount is refused', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    for (const amount of [0, -5, null, undefined]) {
      const od = fakeOrderDesk(ORDER);
      const r = await applyShippingUpgrade({ ...ARGS, amount, fetchImpl: od.fetchImpl });
      assert.equal(r.applied, false, `amount ${amount} must be refused`);
      assert.equal(od.calls.length, 0);
    }
  });

  test('a failed read never becomes a write', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER, { getStatus: 500 });
    const r = await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, false);
    assert.match(r.error, /GET 500/);
    assert.equal(od.put(), undefined);
  });

  test('a failed write is reported, not swallowed', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER, { putStatus: 422 });
    const r = await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, false);
    assert.match(r.error, /PUT 422/);
  });
});

describe('a duplicate webhook must not charge the record twice', () => {
  test('upgradeAlreadyApplied finds the invoice in the notes', () => {
    const done = { order_notes: [{ content: 'Shipping upgraded ... (D169)' }] };
    assert.equal(upgradeAlreadyApplied(done, 'D169'), true);
    assert.equal(upgradeAlreadyApplied(done, 'D170'), false);
    assert.equal(upgradeAlreadyApplied({ order_notes: [] }, 'D169'), false);
    assert.equal(upgradeAlreadyApplied(done, ''), false);
  });

  test('a second delivery reads, sees itself, and does not write', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const first = fakeOrderDesk({ ...ORDER });
    const a = await applyShippingUpgrade({ ...ARGS, fetchImpl: first.fetchImpl });
    assert.equal(a.applied, true);

    // OrderDesk now holds what the first call wrote.
    const second = fakeOrderDesk(first.put().body);
    const b = await applyShippingUpgrade({ ...ARGS, fetchImpl: second.fetchImpl });
    assert.equal(b.applied, false);
    assert.equal(b.skipped, 'duplicate');
    assert.equal(second.put(), undefined, 'must not write a second time');
  });

  test('so the total moves once, not twice', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const first = fakeOrderDesk({ ...ORDER });
    await applyShippingUpgrade({ ...ARGS, fetchImpl: first.fetchImpl });
    assert.equal(first.put().body.order_total, '312.07');

    const second = fakeOrderDesk(first.put().body);
    await applyShippingUpgrade({ ...ARGS, fetchImpl: second.fetchImpl });
    assert.equal(second.put(), undefined);
  });
});

describe('what it writes', () => {
  test('service, order total and shipping total all move by the difference', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    const r = await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });

    assert.equal(r.applied, true);
    const body = od.put().body;
    assert.equal(body.shipping_method, 'FedEx 1-Day');
    assert.equal(body.order_total, '312.07');     // 278.11 + 33.96
    assert.equal(body.shipping_total, '162.07');  // 128.11 + 33.96
  });

  test('the money does not drift — cents, not floats', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk({ ...ORDER, order_total: '0.10', shipping_total: '0.10' });
    await applyShippingUpgrade({ ...ARGS, amount: 0.20, fetchImpl: od.fetchImpl });
    assert.equal(od.put().body.order_total, '0.30', '0.1 + 0.2 must be 0.30');
  });

  test('a store without shipping_total does not gain the field', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const { shipping_total, ...noShipTotal } = ORDER;
    const od = fakeOrderDesk(noShipTotal);
    await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal('shipping_total' in od.put().body, false);
    assert.equal(od.put().body.order_total, '312.07');
  });

  test('a note records what happened, naming the invoice', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    const notes = od.put().body.order_notes;
    assert.equal(notes.length, 2, 'the existing note must survive');
    assert.equal(notes[0].content, 'printed');
    assert.match(notes[1].content, /FedEx 2-Days -> FedEx 1-Day/);
    assert.match(notes[1].content, /\$33\.96/);
    assert.match(notes[1].content, /D169/);
  });

  test('the folder is never touched', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk({ ...ORDER, folder_id: '73068' });
    await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal(od.put().body.folder_id, '73068', 'the upgrade must not re-route the order');
  });
});

describe('the lost-update window', () => {
  test('it merges onto a FRESH read, not a copy handed in', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    // Staff renamed the customer after the page was opened.
    const movedOn = { ...ORDER, customer: { name: 'corrected by staff' }, folder_id: '73069' };
    const od = fakeOrderDesk(movedOn);
    await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });

    assert.equal(od.calls[0].method, 'GET', 'must read before writing');
    assert.equal(od.put().body.customer.name, 'corrected by staff',
      "the staff edit must survive — this is the bug in the legacy full-object PUT");
    assert.equal(od.put().body.folder_id, '73069');
  });
});

describe('tax goes to the tax field, not the shipping field', () => {
  test('each of the three numbers lands where it belongs', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    const r = await applyShippingUpgrade({ ...ARGS, tax: 2.72, fetchImpl: od.fetchImpl });

    const b = od.put().body;
    assert.equal(b.shipping_total, '162.07', 'shipping gets the shipping charge only');
    assert.equal(b.tax_total, '2.72', 'tax gets the tax only');
    assert.equal(b.order_total, '314.79', 'the grand total gets both: 278.11 + 33.96 + 2.72');
    assert.equal(r.paid, '36.68');
  });

  test('the totals still add up after the write', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    await applyShippingUpgrade({ ...ARGS, tax: 2.72, fetchImpl: od.fetchImpl });
    const b = od.put().body;
    const products = Number(ORDER.order_total) - Number(ORDER.shipping_total) - Number(ORDER.tax_total);
    const sum = products + Number(b.shipping_total) + Number(b.tax_total);
    assert.equal(Math.round(sum * 100) / 100, Number(b.order_total));
  });

  test('no tax means no tax field is touched', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    await applyShippingUpgrade({ ...ARGS, tax: 0, fetchImpl: od.fetchImpl });
    assert.equal(od.put().body.tax_total, '0.00', 'unchanged');
    assert.equal(od.put().body.order_total, '312.07');
  });

  test('a store without tax_total does not gain the field', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const { tax_total, ...noTax } = ORDER;
    const od = fakeOrderDesk(noTax);
    await applyShippingUpgrade({ ...ARGS, tax: 2.72, fetchImpl: od.fetchImpl });
    assert.equal('tax_total' in od.put().body, false);
    // the money still has to be accounted for in the grand total
    assert.equal(od.put().body.order_total, '314.79');
  });

  test('negative tax is refused', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    const r = await applyShippingUpgrade({ ...ARGS, tax: -1, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, false);
    assert.equal(od.calls.length, 0);
  });

  test('the note says what the customer actually paid', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    await applyShippingUpgrade({ ...ARGS, tax: 2.72, fetchImpl: od.fetchImpl });
    const note = od.put().body.order_notes.at(-1).content;
    assert.match(note, /\$33\.96/);
    assert.match(note, /\$2\.72 tax/);
    assert.match(note, /= \$36\.68/);
  });
});

describe('pickup converted to delivery', () => {
  const PICKUP = {
    id: '777', shipping_method: 'Georgia Warehouse',
    order_total: '150.00', shipping_total: '0.00', tax_total: '12.00',
    shipping: { first_name: 'Ana', last_name: 'Lee', company: 'Lee Co', phone: '555',
      address1: '1 Billing Rd', city: 'Decatur', state: 'GA', postal_code: '30030', country: 'US' },
    order_notes: [],
  };
  const TO = { address1: '1 Peachtree St', address2: 'Suite 4', city: 'Atlanta', province: 'GA', zip: '30303', country: 'US' };
  const CONVERT = { ...ARGS, orderDeskId: '777', toMethod: 'FedEx 2-Days', amount: 38.2, tax: 3.06, deliverTo: TO };

  test('writes the method, the address and the money together', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(PICKUP);
    const r = await applyShippingUpgrade({ ...CONVERT, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, true);
    assert.equal(r.converted, true);
    const body = od.put().body;
    assert.equal(body.shipping_method, 'FedEx 2-Days');
    assert.equal(body.order_total, '191.26');
    assert.equal(body.shipping_total, '38.20');
    assert.equal(body.tax_total, '15.06');
    assert.equal(body.shipping.address1, '1 Peachtree St');
    assert.equal(body.shipping.address2, 'Suite 4');
    assert.equal(body.shipping.city, 'Atlanta');
    assert.equal(body.shipping.postal_code, '30303');
    assert.match(body.order_notes.at(-1).content,
      /^Pickup converted to delivery Georgia Warehouse -> FedEx 2-Days by customer, \+\$38\.20 \+ \$3\.06 tax = \$41\.26 \(D169\)\. Deliver to: 1 Peachtree St/);
  });

  test('keeps who it is for: name, company and phone are untouched', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(PICKUP);
    await applyShippingUpgrade({ ...CONVERT, fetchImpl: od.fetchImpl });
    const s = od.put().body.shipping;
    assert.equal(s.first_name, 'Ana');
    assert.equal(s.company, 'Lee Co');
    assert.equal(s.phone, '555');
  });

  test('a pickup without an address is refused, and nothing is written', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(PICKUP);
    const r = await applyShippingUpgrade({ ...CONVERT, deliverTo: undefined, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, false);
    assert.match(r.error, /needs a delivery address/);
    assert.equal(od.put(), undefined);
  });

  test('an incomplete address is refused', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(PICKUP);
    const r = await applyShippingUpgrade({ ...CONVERT, deliverTo: { ...TO, zip: '' }, fetchImpl: od.fetchImpl });
    assert.match(r.error, /incomplete/);
    assert.equal(od.put(), undefined);
  });

  test('an address on an order that is not a pickup is refused: upgrades never re-address', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    const r = await applyShippingUpgrade({ ...ARGS, deliverTo: TO, fetchImpl: od.fetchImpl });
    assert.equal(r.applied, false);
    assert.match(r.error, /not a pickup/);
    assert.equal(od.put(), undefined);
  });

  test('a plain upgrade never carries a shipping block it did not have', async () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    const od = fakeOrderDesk(ORDER);
    await applyShippingUpgrade({ ...ARGS, fetchImpl: od.fetchImpl });
    assert.equal(od.put().body.shipping, undefined);
    assert.match(od.put().body.order_notes.at(-1).content, /^Shipping upgraded /);
  });

  test('switch off: the address is in the reported intent, and nothing is sent', async () => {
    const od = fakeOrderDesk(PICKUP);
    const r = await applyShippingUpgrade({ ...CONVERT, fetchImpl: od.fetchImpl });
    assert.equal(r.skipped, 'disabled');
    assert.equal(r.intent.deliverTo.zip, '30303');
    assert.equal(od.calls.length, 0);
  });
});
