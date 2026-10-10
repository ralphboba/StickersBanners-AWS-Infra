// The customer page's API, run for real with the row store and Shopify faked.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeHandler } from '../../src/functions/order-status-api/routes.mjs';

const URL = 'https://stickersbanners.myshopify.com/1234/orders/abcdef0123456789abcdef?key=k';

const pickupRow = (over = {}) => ({
  orderName: 'S70001',
  folderId: '73068',                      // GA production
  orderStatusUrl: URL,
  totals: { subtotal: 150 },
  shipping: { method: 'Georgia Warehouse', state: 'GA', postalCode: '30301' },
  items: [{ name: 'Die Cut Stickers' }],
  ...over,
});

// Live checkout rates at a $150 subtotal (2026-09-28), in cents.
const RATE = { 'FedEx Ground': 2567, 'FedEx 3-Days': 8673, 'FedEx 2-Days': 12811, 'FedEx 1-Day': 16207 };

let calls;
let handler;
/**
 * @param {object} row          the DynamoDB row
 * @param {object} [opts]
 * @param {object|null} [opts.quoteResult]  what the pricer answers (default: priced)
 * @param {boolean} [opts.estimates]        whether rate estimates are available
 */
function fake(row, { quoteResult, estimates = true } = {}) {
  calls = { quote: [], estimates: [], shopify: 0 };
  handler = makeHandler({
    loadRow: async (name) => (row && name === row.orderName ? row : undefined),
    loadShopifyOrder: async () => { calls.shopify += 1; return { name: row?.orderName }; },
    quote: async (args) => {
      calls.quote.push(args);
      if (quoteResult) return quoteResult;
      const shippingCents = RATE[args.to] - (args.deliverTo ? 0 : RATE['FedEx 2-Days']);
      return { ok: true, to: args.to, fromCents: args.deliverTo ? 0 : RATE['FedEx 2-Days'], toCents: RATE[args.to],
        shippingCents, taxCents: 200, totalCents: shippingCents + 200 };
    },
    estimates: async (args) => {
      calls.estimates.push(args);
      return estimates ? args.services.map((s) => ({ service: s, shippingCents: RATE[s] })) : null;
    },
  });
}

const get = (o, s = URL) => handler({
  requestContext: { http: { method: 'GET' } },
  queryStringParameters: { o, s },
});
const post = (body) => handler({
  requestContext: { http: { method: 'POST' } },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const read = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });

const ADDRESS = { address1: '1 Peachtree St', city: 'Atlanta', province: 'ga', zip: '30303', country: 'US' };

beforeEach(() => fake(pickupRow()));

describe('GET /my-order for a pickup order', () => {
  // Kai (2026-10-05): a pickup customer enters the delivery address first,
  // then sees the services priced for it, like checkout. Nothing is priced
  // before there is an address.
  test('asks for the address first: the four services named, nothing priced, Shopify not asked', async () => {
    const { status, body } = read(await get('S70001'));
    assert.equal(status, 200);
    assert.equal(body.shipping.pickup, true);
    assert.equal(body.shipping.needsAddress, true);
    assert.equal(body.shipping.canUpgrade, false);
    assert.equal(body.shipping.reason, null);
    assert.deepEqual(body.shipping.delivery.options.map((o) => o.service), ['FedEx Ground', 'FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day']);
    assert.equal(calls.quote.length, 0);
    assert.equal(calls.estimates.length, 0);
    assert.equal(calls.shopify, 0);
  });

  test('with an address: every service priced at it by Shopify, tax included', async () => {
    const { status, body } = read(await post({ o: 'S70001', s: URL, address: ADDRESS }));
    assert.equal(status, 200);
    assert.deepEqual(body.options.map((o) => o.to), ['FedEx Ground', 'FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day']);
    for (const o of body.options) {
      assert.equal(o.final, true);
      assert.equal(o.total, o.shipping + o.tax);
    }
    assert.equal(calls.quote.length, 4);
    assert.ok(calls.quote.every((q) => q.deliverTo.province === 'GA' && q.deliverTo.zip === '30303'));
    assert.ok(calls.quote.every((q) => q.rateCache === calls.quote[0].rateCache));
  });

  test('an address it cannot ship to is refused before Shopify is asked', async () => {
    const po = read(await post({ o: 'S70001', s: URL, address: { ...ADDRESS, address1: 'PO Box 12' } }));
    assert.equal(po.status, 422);
    const ak = read(await post({ o: 'S70001', s: URL, address: { ...ADDRESS, province: 'AK' } }));
    assert.equal(ak.status, 422);
    assert.equal(calls.quote.length, 0);
  });

  test('says nothing internal: no folder id, no facility', async () => {
    const res = await get('S70001');
    assert.ok(!res.body.includes('73068'));
    assert.ok(!/folder|facility/i.test(res.body));
  });

  test('a wrong token and a missing order look the same', async () => {
    const wrong = read(await get('S70001', URL.replace('abcdef0123', 'zzzzzz0123')));
    const missing = read(await get('S99999'));
    assert.equal(wrong.status, 404);
    assert.deepEqual(wrong, missing);
  });
});

describe('GET /my-order for an upgrade', () => {
  const upgradeRow = () => pickupRow({ shipping: { method: 'FedEx 2-Days', state: 'GA', postalCode: '30301' } });

  test('shows Shopify’s figures, converted from cents', async () => {
    fake(upgradeRow());
    const { body } = read(await get('S70001'));
    assert.equal(body.shipping.canUpgrade, true);
    assert.deepEqual(body.shipping.upgrade, {
      to: 'FedEx 1-Day', shipping: 33.96, tax: 2, total: 35.96, final: true,
      currentPrice: 128.11, newPrice: 162.07,
    });
  });

  test('tells the pricer which service OrderDesk thinks it is on', async () => {
    fake(upgradeRow());
    await get('S70001');
    assert.equal(calls.quote[0].expectedFrom, 'FedEx 2-Days');
    assert.equal(calls.quote[0].to, 'FedEx 1-Day');
  });

  test('a refusal from the pricer shows no price, and its own words — never the internal code', async () => {
    fake(upgradeRow(), { quoteResult: { ok: false, reason: 'shipping_discounted' } });
    const res = await get('S70001');
    const { body } = read(res);
    assert.equal(body.shipping.canUpgrade, false);
    assert.equal(body.shipping.upgrade, null);
    assert.match(body.shipping.reason, /shipping discount.*contact us/i);
    assert.ok(!res.body.includes('shipping_discounted'));
  });

  test('every case says something different (Kai, 2026-10-08)', async () => {
    const reasons = ['shipping_discounted', 'method_changed', 'price_unverified', 'balance_due', 'tax_exempt_order',
      'not_usd', 'shipping_unverified', 'no_address', 'rates_unavailable', 'edit_begin_failed', 'service_unavailable'];
    const seen = new Map();
    for (const reason of reasons) {
      fake(upgradeRow(), { quoteResult: { ok: false, reason } });
      const text = read(await get('S70001')).body.shipping.reason;
      assert.ok(text, reason);
      assert.ok(!seen.has(text), `${reason} shares its message with ${seen.get(text)}`);
      seen.set(text, reason);
    }
  });

  test('a locked order never reaches Shopify', async () => {
    fake(pickupRow({ folderId: '3516', shipping: { method: 'FedEx 2-Days' } }));
    await get('S70001');
    assert.equal(calls.shopify, 0);
    assert.equal(calls.quote.length, 0);
  });
});

describe('POST /my-order/quote', () => {
  const ok = { o: 'S70001', s: URL, service: 'FedEx 2-Days', address: ADDRESS };

  test('prices the full service, for the typed address, tax included', async () => {
    const { status, body } = read(await post(ok));
    assert.equal(status, 200);
    assert.equal(body.service, 'FedEx 2-Days');
    assert.equal(body.shipping, 128.11);
    assert.equal(body.tax, 2);
    assert.equal(body.total, 130.11);
    assert.equal(body.final, true);
    // The typed address, not the pickup record's 30301.
    assert.equal(calls.quote[0].deliverTo.zip, '30303');
    assert.equal(calls.quote[0].deliverTo.province, 'GA');
    assert.equal(calls.quote[0].expectedFrom, 'Georgia Warehouse');
  });

  test('is authorised exactly like GET', async () => {
    assert.equal((await post({ ...ok, s: URL.replace('abcdef', 'ffffff') })).statusCode, 404);
    assert.equal((await post({ ...ok, s: '' })).statusCode, 400);
    assert.equal(calls.quote.length, 0);
  });

  test('re-decides from the current folder, not from what the page showed', async () => {
    fake(pickupRow({ folderId: '3516' }));   // completed since the page loaded
    const { status, body } = read(await post(ok));
    assert.equal(status, 409);
    assert.equal(body.error, 'not_convertible');
  });

  test('refuses an order that is not a pickup', async () => {
    fake(pickupRow({ shipping: { method: 'FedEx Ground' } }));
    assert.equal((await post(ok)).statusCode, 409);
  });

  test('refuses a service it does not offer', async () => {
    for (const service of ['Saturday Overnight', 'FedEx 2-Day', '', 'Georgia Warehouse']) {
      assert.equal((await post({ ...ok, service })).statusCode, 400, service);
    }
  });

  test('refuses an incomplete address', async () => {
    for (const drop of ['address1', 'city', 'province', 'zip']) {
      const address = { ...ADDRESS, [drop]: '' };
      assert.equal(read(await post({ ...ok, address })).body.error, 'address_incomplete', drop);
    }
    assert.equal(read(await post({ ...ok, address: { ...ADDRESS, province: 'Georgia' } })).body.error,
      'address_incomplete');
  });

  test('applies Danny’s destination rules to the typed address', async () => {
    for (const province of ['HI', 'AK', 'PR', 'VI']) {
      assert.equal(read(await post({ ...ok, address: { ...ADDRESS, province } })).body.error, 'destination', province);
    }
    assert.equal(read(await post({ ...ok, address: { ...ADDRESS, address1: 'PO Box 55' } })).body.error, 'po_box');
    assert.equal(read(await post({ ...ok, address: { ...ADDRESS, country: 'CA' } })).body.error, 'outside_us');
    assert.equal(calls.quote.length, 0, 'none of these reach Shopify');
  });

  test('when Shopify cannot price it, no figure at all', async () => {
    fake(pickupRow(), { quoteResult: { ok: false, reason: 'calc_inconsistent' } });
    const { status, body } = read(await post(ok));
    assert.equal(status, 422);
    assert.equal(body.error, 'unpriceable');
    assert.equal(body.total, undefined);
  });

  test('a service checkout does not offer here says so', async () => {
    fake(pickupRow(), { quoteResult: { ok: false, reason: 'service_unavailable' } });
    const { body } = read(await post(ok));
    assert.equal(body.error, 'service_unavailable');
  });

  test('bad JSON is a 400, not a crash', async () => {
    assert.equal((await post('{nope')).statusCode, 400);
  });
});

describe('no-options messages (Kai, 2026-10-08)', () => {
  test('Completed Orders reads as shipped and on its way; every message ends by pointing to the team', async () => {
    fake(pickupRow({ folderId: '3516', shipping: { method: 'FedEx 2-Days', state: 'GA', postalCode: '30301' } }));
    const shipped = read(await get('S70001')).body.shipping.reason;
    assert.match(shipped, /^Your order has been shipped and is on its way to your address\./);
    assert.match(shipped, /If you have any questions, please contact our team\.$/);
    fake(pickupRow({ shipping: { method: 'FedEx 1-Day', state: 'GA', postalCode: '30301' } }));
    assert.match(read(await get('S70001')).body.shipping.reason, /fastest service\. If you have any questions, please contact our team\.$/);
    fake(pickupRow({ folderId: '3516' }));
    assert.match(read(await get('S70001')).body.shipping.reason, /^Your order has been completed\. If you have any questions/);
  });
});
