// The customer page's API, run for real with the row store and Shopify faked.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { makeHandler } from '../../src/functions/order-status-api/routes.mjs';
import { priceOf } from '../../src/shared/fedex-rates.mjs';

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

let calls;
let handler;
function fake(row, priced = { subtotal: 1, tax: 2, total: 3 }) {
  calls = [];
  handler = makeHandler({
    loadRow: async (name) => (row && name === row.orderName ? row : undefined),
    priceWithTax: async (r, quote, title) => {
      calls.push({ r, quote, title });
      return priced && { subtotal: quote.amount, tax: priced.tax, total: quote.amount + priced.tax };
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
  test('offers delivery, at card price, not final', async () => {
    const { status, body } = read(await get('S70001'));
    assert.equal(status, 200);
    assert.equal(body.shipping.canConvert, true);
    assert.equal(body.shipping.canUpgrade, false);
    assert.equal(body.shipping.reason, null);
    assert.equal(body.shipping.delivery.needsAddress, true);
    assert.equal(body.shipping.delivery.final, false);
    assert.deepEqual(body.shipping.delivery.options.map((o) => o.service),
      ['FedEx Ground', 'FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day']);
    for (const o of body.shipping.delivery.options) assert.equal(o.shipping, priceOf(150, o.service));
  });

  test('asks Shopify for nothing: there is no address to tax yet', async () => {
    await get('S70001');
    assert.equal(calls.length, 0);
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
  test('taxes the upgrade for the order’s own address', async () => {
    fake(pickupRow({ shipping: { method: 'FedEx 2-Days', state: 'GA', postalCode: '30301', street: '1 Main', city: 'Atlanta' } }));
    const { body } = read(await get('S70001'));
    assert.equal(body.shipping.canUpgrade, true);
    assert.equal(body.shipping.upgrade.final, true);
    assert.equal(calls[0].r.shipping.postalCode, '30301');
  });
});

describe('POST /my-order/quote', () => {
  const ok = { o: 'S70001', s: URL, service: 'FedEx 2-Days', address: ADDRESS };

  test('prices the full service, for the typed address, tax included', async () => {
    const { status, body } = read(await post(ok));
    assert.equal(status, 200);
    assert.equal(body.service, 'FedEx 2-Days');
    assert.equal(body.shipping, priceOf(150, 'FedEx 2-Days'));
    assert.equal(body.tax, 2);
    assert.equal(body.final, true);
    // The typed address, not the pickup record's 30301.
    assert.equal(calls[0].r.shipping.zip, '30303');
    assert.equal(calls[0].r.shipping.province, 'GA');
    assert.equal(calls[0].r.shipping.postalCode, undefined);
    assert.match(calls[0].title, /^Delivery: FedEx 2-Days/);
  });

  test('is authorised exactly like GET', async () => {
    assert.equal((await post({ ...ok, s: URL.replace('abcdef', 'ffffff') })).statusCode, 404);
    assert.equal((await post({ ...ok, s: '' })).statusCode, 400);
    assert.equal(calls.length, 0);
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
    assert.equal(calls.length, 0, 'none of these reach Shopify');
  });

  test('when Shopify cannot price it, nothing is presented as final', async () => {
    fake(pickupRow(), null);
    const { status, body } = read(await post(ok));
    assert.equal(status, 200);
    assert.equal(body.final, false);
    assert.equal(body.total, null);
  });

  test('bad JSON is a 400, not a crash', async () => {
    assert.equal((await post('{nope')).statusCode, 400);
  });
});
