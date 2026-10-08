// Add-ons on the page's routes: GET lists them, POST /quote prices a selection,
// POST /request commits it — and the shipping-only path is untouched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeHandler } from '../../src/functions/order-status-api/routes.mjs';

const URL = 'https://stickersbanners.myshopify.com/1234/orders/abcdef0123456789abcdef?key=k';
const ROW = { orderName: 'S1', folderId: '73068', orderStatusUrl: URL, source: { orderDeskId: '49' },
  shipping: { method: 'FedEx 2-Days', state: 'GA' }, items: [{ name: 'Banner' }] };
const STAND = { variantId: 'gid://shopify/ProductVariant/1', title: "10'x8' Telescopic Adjustable Stand", sku: 'SKUBS08X10', price: 14900 };
const CATALOG = [{ productId: 'P1', title: 'Banner Stands', image: null, options: [STAND] }];
const AQ = { ok: true, mode: 'addons', from: 'FedEx 2-Days', to: 'FedEx 2-Days', itemsCents: 14900, shippingCents: 945, taxCents: 951, totalCents: 16796,
  edit: { orderId: 'gid://shopify/Order/1', calculatedOrderId: 'gid://shopify/CalculatedOrder/9', restore: { title: 'FedEx 2-Days', priceCents: 12811 } } };

function build({ row = ROW, aq = AQ, pending = null, commit, order, addOnOrders = 'S1' } = {}) {
  const log = { quotes: [], commits: [], saved: [], invoices: [] };
  const deps = {
    loadRow: async () => row,
    loadShopifyOrder: async () => order ?? { name: 'S1', id: 'gid://shopify/Order/1', outstandingCents: 0, lineItemIds: ['gid://shopify/LineItem/500'],
      shippingLines: [{ title: row.shipping.method }] },
    quote: async () => ({ ok: false, reason: 'not_an_upgrade' }),
    estimates: async () => null,
    loadPending: async () => pending,
    loadAddOns: async () => CATALOG,
    quoteAddOns: async (a) => { log.quotes.push(a); return aq; },
    addOnOrders,
    now: () => 1790000000000,
    commitEdit: async (a) => { log.commits.push(a); return commit ?? { committed: true, outstandingCents: 16796, paymentUrl: 'https://pay',
      lineItems: [{ id: 'gid://shopify/LineItem/500', quantity: 1 }, { id: 'gid://shopify/LineItem/900', quantity: 1 }] }; },
    savePending: async (c) => { log.saved.push(c); },
    sendInvoice: async (a) => { log.invoices.push(a); return { sent: true }; },
  };
  return { handler: makeHandler(deps), log };
}
const call = (h, path, b, method = 'POST') => h({ requestContext: { http: { method, path } }, rawPath: path,
  body: b ? JSON.stringify(b) : undefined, queryStringParameters: method === 'GET' ? b : undefined });
const read = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const SEL = { o: 'S1', s: URL, addOns: [{ variantId: STAND.variantId, quantity: 1 }] };

describe('add-ons on the page', () => {
  test('GET lists them on any open order — even one already on the fastest service', async () => {
    const { handler } = build({ row: { ...ROW, shipping: { method: 'FedEx 1-Day', state: 'GA' } } });
    const { body } = read(await call(handler, '/my-order', { o: 'S1', s: URL }, 'GET'));
    assert.deepEqual(body.addOns, CATALOG);
  });
  test('GET lists none in Completed Orders', async () => {
    const { handler } = build({ row: { ...ROW, folderId: '3516' } });
    assert.deepEqual(read(await call(handler, '/my-order', { o: 'S1', s: URL }, 'GET')).body.addOns, []);
  });

  test('POST /quote prices the selection: items, shipping re-price, tax, total', async () => {
    const { handler, log } = build();
    const { status, body } = read(await call(handler, '/my-order/quote', SEL));
    assert.equal(status, 200);
    assert.deepEqual(body, { items: [{ product: 'Banner Stands', title: STAND.title, sku: 'SKUBS08X10', quantity: 1, unit: 149 }],
      itemsTotal: 149, shippingService: 'FedEx 2-Days', shipping: 9.45, tax: 9.51, total: 167.96 });
    assert.equal(log.quotes[0].to, null);
  });
  test('an item not on the list is refused with its own words; nothing selected too', async () => {
    const { handler } = build();
    const bad = read(await call(handler, '/my-order/quote', { ...SEL, addOns: [{ variantId: 'gid://shopify/ProductVariant/666', quantity: 1 }] }));
    assert.equal(bad.body.error, 'addon_not_offered');
    assert.equal(read(await call(handler, '/my-order/quote', { ...SEL, addOns: [] })).body.error, 'nothing_selected');
  });

  test('POST /request commits once at the shown total, records the items and their new lines, invoices', async () => {
    const { handler, log } = build();
    const { status, body } = read(await call(handler, '/my-order/request', { ...SEL, expectedTotal: 167.96 }));
    assert.equal(status, 200);
    assert.equal(body.paymentUrl, 'https://pay');
    assert.equal(log.commits.length, 1);
    const last = log.saved.at(-1);
    assert.deepEqual([last.kind, last.itemsCents, last.confirmed], ['addons', 14900, true]);
    assert.deepEqual(last.addOns, [{ variantId: STAND.variantId, sku: 'SKUBS08X10', product: 'Banner Stands', title: STAND.title, quantity: 1, unitCents: 14900 }]);
    assert.deepEqual(last.addedLineItemIds, ['gid://shopify/LineItem/900']);
    assert.match(log.invoices[0].customMessage, /added Banner Stands 10'x8' Telescopic Adjustable Stand x1/);
  });
  test('a different total: nothing committed, the new figures go back', async () => {
    const { handler, log } = build();
    const { status, body } = read(await call(handler, '/my-order/request', { ...SEL, expectedTotal: 100 }));
    assert.equal(status, 409);
    assert.equal(body.total, 167.96);
    assert.equal(log.commits.length, 0);
  });
  test('an unpaid choice with add-ons is replaced: its lines are taken back out in the same edit', async () => {
    const pending = { status: 'pending', ref: 'CHG-OLD', from: 'FedEx 2-Days', to: 'FedEx 2-Days', itemsCents: 7200,
      addOns: [{ sku: 'SKURC0308', quantity: 1 }], addedLineItemIds: ['gid://shopify/LineItem/800'],
      restore: { title: 'FedEx 2-Days', priceCents: 12811 } };
    const order = { name: 'S1', id: 'gid://shopify/Order/1', outstandingCents: 7700, currentTotalCents: 30000, currentSubtotalCents: 20000,
      lineItemIds: ['gid://shopify/LineItem/500', 'gid://shopify/LineItem/800'],
      shippingLines: [{ id: 'L', title: 'FedEx 2-Days', originalCents: 12811, discountedCents: 12811 }] };
    const { handler, log } = build({ pending, order });
    await call(handler, '/my-order/request', { ...SEL, expectedTotal: 167.96 });
    assert.deepEqual(log.quotes[0].removeLineItemIds, ['gid://shopify/LineItem/800']);
    assert.equal(log.quotes[0].order.currentSubtotalCents, 20000 - 7200);
    assert.equal(log.saved[0].replaces, 'CHG-OLD');
  });
  test('the shipping-only request (no addOns) still takes its own path', async () => {
    const { handler, log } = build();
    await call(handler, '/my-order/request', { o: 'S1', s: URL, service: 'FedEx 1-Day', expectedTotal: 10 });
    assert.equal(log.quotes.length, 0);
  });

  test('only on the orders named at deploy; none when unset (Kai: "주문 하나에만")', async () => {
    for (const addOnOrders of ['', 'S999']) {
      const { handler, log } = build({ addOnOrders });
      assert.deepEqual(read(await call(handler, '/my-order', { o: 'S1', s: URL }, 'GET')).body.addOns, []);
      assert.equal(read(await call(handler, '/my-order/quote', SEL)).body.error, 'addon_not_offered');
      await call(handler, '/my-order/request', { ...SEL, expectedTotal: 167.96 });
      assert.equal(log.commits.length + log.quotes.length, 0);
    }
    const all = build({ addOnOrders: '*' });
    assert.deepEqual(read(await call(all.handler, '/my-order', { o: 'S1', s: URL }, 'GET')).body.addOns, CATALOG);
  });
});
