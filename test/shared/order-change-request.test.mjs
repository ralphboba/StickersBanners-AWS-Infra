// POST /my-order/request — the only route that commits anything.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeHandler } from '../../src/functions/order-status-api/routes.mjs';

const URL = 'https://stickersbanners.myshopify.com/1234/orders/abcdef0123456789abcdef?key=k';
const ROW = { orderName: 'S1', folderId: '73068', orderStatusUrl: URL, source: { orderDeskId: '49' },
  shipping: { method: 'FedEx 2-Days', state: 'GA' }, items: [{ name: 'X-Banner' }] };
const QUOTE = { ok: true, from: 'FedEx 2-Days', to: 'FedEx 1-Day', shippingCents: 3396, taxCents: 225, totalCents: 3621,
  edit: { orderId: 'gid://shopify/Order/1', calculatedOrderId: 'gid://shopify/CalculatedOrder/9', restore: { title: 'FedEx 2-Days', priceCents: 12811 } } };

function build({ row = ROW, quote = QUOTE, pending = null, commit = { committed: true, outstandingCents: 3621 }, invoice = { sent: true }, writes = true } = {}) {
  const log = { commits: [], saved: [], invoices: [] };
  const deps = {
    loadRow: async (n) => (n === 'S1' ? row : undefined),
    loadShopifyOrder: async () => ({ name: 'S1' }),
    quote: async () => quote,
    estimates: async () => null,
    loadPending: async () => pending,
    now: () => 1790000000000,
  };
  if (writes) Object.assign(deps, {
    commitEdit: async (a) => { log.commits.push(a); return commit; },
    savePending: async (c) => { log.saved.push(c); },
    sendInvoice: async (a) => { log.invoices.push(a); return invoice; },
  });
  return { handler: makeHandler(deps), log };
}
const post = (h, b) => h({ requestContext: { http: { method: 'POST', path: '/my-order/request' } }, rawPath: '/my-order/request', body: JSON.stringify(b) });
const OK = { o: 'S1', s: URL, service: 'FedEx 1-Day', expectedTotal: 36.21 };
const read = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

describe('Send me the invoice', () => {
  test('same balance as shown: commit, record, invoice', async () => {
    const { handler, log } = build();
    const { status, body } = read(await post(handler, OK));
    assert.equal(status, 200);
    assert.deepEqual(body, { requested: true, total: 36.21, invoiceSent: true });
    assert.equal(log.commits[0].calculatedOrderId, 'gid://shopify/CalculatedOrder/9');
    assert.equal(log.saved[0].status, 'pending');
    assert.equal(log.saved[0].orderDeskId, '49');
    assert.equal(log.saved[0].shippingCents, 3396);
    assert.equal(log.saved[0].revertAfter, new Date(1790000000000 + 48 * 3600e3).toISOString());
    assert.deepEqual(log.saved[0].restore, { title: 'FedEx 2-Days', priceCents: 12811 });
    assert.equal(log.invoices.length, 1);
  });

  test('a staff test order is marked test (left out of the daily count); a real one is not', async () => {
    const real = build();
    await post(real.handler, OK);
    assert.equal(real.log.saved[0].test, undefined);
    const t = build({ row: { ...ROW, testOrder: true } });
    await post(t.handler, OK);
    assert.equal(t.log.saved[0].test, true);
  });

  test('the balance moved since the page loaded: nothing committed, the new figure returned', async () => {
    const { handler, log } = build({ quote: { ...QUOTE, totalCents: 3622, taxCents: 226 } });
    const { status, body } = read(await post(handler, OK));
    assert.equal(status, 409);
    assert.equal(body.error, 'price_changed');
    assert.equal(body.total, 36.22);
    assert.equal(log.commits.length, 0);
  });

  test('switch off: 503, nothing recorded, no invoice', async () => {
    const { handler, log } = build({ commit: { committed: false, skipped: 'disabled' } });
    assert.equal((await post(handler, OK)).statusCode, 503);
    assert.equal(log.saved.length, 0);
    assert.equal(log.invoices.length, 0);
  });

  test('the read-only function refuses the route outright', async () => {
    const { handler } = build({ writes: false });
    assert.equal((await post(handler, OK)).statusCode, 503);
  });

  test('Shopify committed a different balance: flagged, no invoice', async () => {
    const { handler, log } = build({ commit: { committed: true, outstandingCents: 3700 } });
    assert.equal((await post(handler, OK)).statusCode, 502);
    assert.equal(log.saved[0].status, 'attention');
    assert.equal(log.invoices.length, 0);
  });

  test('a second click is harmless; a different service while one is pending is refused', async () => {
    const pending = { status: 'pending', to: 'FedEx 1-Day', shippingCents: 3396, taxCents: 225 };
    const same = build({ pending });
    assert.deepEqual(read(await post(same.handler, OK)).body, { requested: true, already: true, total: 36.21 });
    assert.equal(same.log.commits.length, 0);
    const other = build({ pending: { ...pending, to: 'FedEx 2-Days' } });
    assert.equal((await post(other.handler, OK)).statusCode, 409);
  });

  test('a service the page does not offer is refused before Shopify is asked', async () => {
    const { handler, log } = build();
    assert.equal((await post(handler, { ...OK, service: 'FedEx 3-Days' })).statusCode, 409);
    assert.equal((await post(handler, { ...OK, expectedTotal: 0 })).statusCode, 400);
    assert.equal(log.commits.length, 0);
  });

  test('a wrong token is the same 404 as everywhere else', async () => {
    const { handler, log } = build();
    assert.equal((await post(handler, { ...OK, s: URL.replace('abcdef', 'ffffff') })).statusCode, 404);
    assert.equal(log.commits.length, 0);
  });
});

describe('Shopify payment page', () => {
  const PAY = 'https://stickersbanners.com/94758830375/order_payment/7504207282471?secret=x';

  test('when Shopify gives a payment page, the customer is sent there and no invoice is emailed', async () => {
    const { handler, log } = build({ commit: { committed: true, outstandingCents: 3621, paymentUrl: PAY } });
    const { status, body } = read(await post(handler, OK));
    assert.equal(status, 200);
    assert.deepEqual(body, { requested: true, total: 36.21, paymentUrl: PAY });
    assert.equal(log.invoices.length, 0);
    assert.equal(log.saved[0].paymentUrl, PAY);
  });

  test('a second click on a pending change goes back to the same payment page', async () => {
    const { handler, log } = build({ pending: { status: 'pending', to: 'FedEx 1-Day', shippingCents: 3396, taxCents: 225, paymentUrl: PAY } });
    const { status, body } = read(await post(handler, OK));
    assert.equal(status, 200);
    assert.equal(body.paymentUrl, PAY);
    assert.equal(log.commits.length, 0);
  });
});

describe('page opened again while an upgrade waits for payment', () => {
  test('GET shows the pending upgrade and the Shopify payment page, nothing new is offered', async () => {
    const PAY = 'https://stickersbanners.com/1/order_payment/2?secret=x';
    const deps = {
      loadRow: async (n) => (n === 'S1' ? ROW : undefined),
      loadShopifyOrder: async () => ({ name: 'S1', outstandingCents: 1738, paymentUrl: PAY }),
      quote: async () => { throw new Error('must not quote'); },
      estimates: async () => null,
      loadPending: async () => ({ status: 'pending', from: 'FedEx Ground', to: 'FedEx 3-Days', shippingCents: 1738, taxCents: 0 }),
    };
    const r = await makeHandler(deps)({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order',
      queryStringParameters: { o: 'S1', s: URL } });
    const body = JSON.parse(r.body);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(body.shipping.awaitingPayment, { from: 'FedEx Ground', to: 'FedEx 3-Days', total: 17.38, paymentUrl: PAY });
    assert.equal(body.shipping.canUpgrade, false);
  });
});

describe('every faster service', () => {
  const GROUND_ROW = { ...ROW, shipping: { ...ROW.shipping, method: 'FedEx Ground' } };
  const priced = { 'FedEx 3-Days': 1738, 'FedEx 2-Days': 3386, 'FedEx 1-Day': 7355 };
  const deps = (extra = {}) => ({
    loadRow: async () => GROUND_ROW,
    loadShopifyOrder: async () => ({ name: 'S1', outstandingCents: 0 }),
    quote: async ({ to }) => (priced[to] ? { ok: true, to, shippingCents: priced[to], taxCents: 0, totalCents: priced[to], fromCents: 1570, toCents: 1570 + priced[to] }
      : { ok: false, reason: 'service_unavailable' }),
    estimates: async () => null,
    ...extra,
  });
  const get = (h) => h({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order', queryStringParameters: { o: 'S1', s: URL } });

  test('a Ground order is offered 3-Days, 2-Days and 1-Day, each with its own Shopify price', async () => {
    const body = JSON.parse((await get(makeHandler(deps()))).body);
    assert.deepEqual(body.shipping.upgrades.map((u) => [u.to, u.total]), [['FedEx 3-Days', 17.38], ['FedEx 2-Days', 33.86], ['FedEx 1-Day', 73.55]]);
    assert.equal(body.shipping.upgrade.to, 'FedEx 3-Days');
  });

  test('an order-level refusal stops the loop and offers nothing', async () => {
    let calls = 0;
    const body = JSON.parse((await get(makeHandler(deps({ quote: async () => { calls += 1; return { ok: false, reason: 'price_unverified' }; } })))).body);
    assert.equal(body.shipping.canUpgrade, false);
    assert.equal(calls, 1);
  });

  test('a service not sold at this subtotal is just left out', async () => {
    delete priced['FedEx 2-Days'];
    const body = JSON.parse((await get(makeHandler(deps()))).body);
    assert.deepEqual(body.shipping.upgrades.map((u) => u.to), ['FedEx 3-Days', 'FedEx 1-Day']);
  });
});

describe('an unpaid choice can still be changed', () => {
  const GROUND_ROW = { ...ROW, shipping: { ...ROW.shipping, method: 'FedEx Ground' } };
  const PAY = 'https://stickersbanners.com/1/order_payment/2?secret=x';
  // Shopify after the customer picked 1-Day and left the payment page.
  const SHOPIFY = { name: 'S1', id: 'gid://shopify/Order/1', outstandingCents: 7355, currentTotalCents: 10000, paymentUrl: PAY,
    shippingLines: [{ id: 'gid://shopify/ShippingLine/9', title: 'FedEx 1-Day', originalCents: 8925, discountedCents: 8925 }] };
  const PENDING = { status: 'pending', ref: 'CHG-S1-1', from: 'FedEx Ground', to: 'FedEx 1-Day', shippingCents: 7355, taxCents: 0,
    paymentUrl: PAY, restore: { title: 'FedEx Ground', priceCents: 1570 } };
  const priced = { 'FedEx 3-Days': 1738, 'FedEx 2-Days': 3386, 'FedEx 1-Day': 7355 };
  const build = ({ shopify = SHOPIFY, pending = PENDING } = {}) => {
    const log = { quotes: [], commits: [], saved: [] };
    const deps = {
      loadRow: async () => GROUND_ROW,
      loadShopifyOrder: async () => shopify,
      loadPending: async () => pending,
      quote: async (a) => {
        log.quotes.push(a);
        const c = priced[a.to];
        return { ok: true, from: 'FedEx Ground', to: a.to, shippingCents: c, taxCents: 0, totalCents: c, fromCents: 1570, toCents: 1570 + c,
          edit: { orderId: 'gid://shopify/Order/1', calculatedOrderId: `calc-${a.to}`, restore: { title: 'FedEx Ground', priceCents: 1570 } } };
      },
      estimates: async () => null,
      commitEdit: async (a) => { log.commits.push(a); return { committed: true, outstandingCents: priced['FedEx 3-Days'], paymentUrl: PAY }; },
      savePending: async (c) => { log.saved.push(c); },
      sendInvoice: async () => ({ sent: true }),
      now: () => 1790000000000,
    };
    return { handler: makeHandler(deps), log };
  };
  const get = (h) => h({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order', queryStringParameters: { o: 'S1', s: URL } });

  test('the page shows every option again, priced from the order before the change, and the pending one to pay', async () => {
    const { handler, log } = build();
    const body = JSON.parse((await get(handler)).body);
    assert.deepEqual(body.shipping.upgrades.map((u) => [u.to, u.total]), [['FedEx 3-Days', 17.38], ['FedEx 2-Days', 33.86], ['FedEx 1-Day', 73.55]]);
    assert.equal(body.shipping.canUpgrade, true);
    assert.deepEqual(body.shipping.awaitingPayment, { from: 'FedEx Ground', to: 'FedEx 1-Day', total: 73.55, paymentUrl: PAY });
    // quoted on the order with Ground put back and the balance taken off
    const o = log.quotes[0].order;
    assert.equal(log.quotes[0].expectedFrom, 'FedEx Ground');
    assert.deepEqual([o.shippingLines[0].title, o.shippingLines[0].originalCents, o.shippingLines[0].id], ['FedEx Ground', 1570, 'gid://shopify/ShippingLine/9']);
    assert.equal(o.outstandingCents, 0);
    assert.equal(o.currentTotalCents, 10000 - 7355);
  });

  test('picking a different speed replaces the unpaid edit and goes to payment for the new amount', async () => {
    const { handler, log } = build();
    const r = await post(handler, { o: 'S1', s: URL, service: 'FedEx 3-Days', expectedTotal: 17.38 });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), { requested: true, total: 17.38, paymentUrl: PAY });
    assert.equal(log.commits[0].calculatedOrderId, 'calc-FedEx 3-Days');
    assert.match(log.commits[0].staffNote, /replaces unpaid CHG-S1-1, FedEx 1-Day/);
    const saved = log.saved[0];
    assert.deepEqual([saved.from, saved.to, saved.shippingCents, saved.replaces, saved.status], ['FedEx Ground', 'FedEx 3-Days', 1738, 'CHG-S1-1', 'pending']);
    assert.deepEqual(saved.restore, { title: 'FedEx Ground', priceCents: 1570 });
  });

  test('the same speed again just returns the payment page', async () => {
    const { handler, log } = build();
    const r = await post(handler, { o: 'S1', s: URL, service: 'FedEx 1-Day', expectedTotal: 73.55 });
    assert.deepEqual(JSON.parse(r.body), { requested: true, already: true, total: 73.55, paymentUrl: PAY });
    assert.equal(log.commits.length, 0);
  });

  test('already paid (webhook not in yet): no switch', async () => {
    const { handler, log } = build({ shopify: { ...SHOPIFY, outstandingCents: 0 } });
    const r = await post(handler, { o: 'S1', s: URL, service: 'FedEx 3-Days', expectedTotal: 17.38 });
    assert.equal(r.statusCode, 409);
    assert.equal(JSON.parse(r.body).error, 'already_paid');
    assert.equal(log.commits.length, 0);
  });

  test('someone changed the Shopify line by hand: no switch', async () => {
    const { handler, log } = build({ shopify: { ...SHOPIFY, shippingLines: [{ ...SHOPIFY.shippingLines[0], title: 'FedEx 2-Days' }] } });
    const r = await post(handler, { o: 'S1', s: URL, service: 'FedEx 3-Days', expectedTotal: 17.38 });
    assert.equal(r.statusCode, 422);
    assert.equal(log.commits.length, 0);
  });
});

describe('orderBeforeChange', () => {
  test('null unless Shopify still carries the unpaid choice with a balance', async () => {
    const { orderBeforeChange } = await import('../../src/shared/shopify-pricing.mjs');
    const order = { outstandingCents: 100, currentTotalCents: 500, shippingLines: [{ id: 'L', title: 'FedEx 1-Day', originalCents: 300, discountedCents: 300 }] };
    const change = { to: 'FedEx 1-Day', restore: { title: 'FedEx Ground', priceCents: 200 } };
    assert.deepEqual(orderBeforeChange(order, change), { outstandingCents: 0, currentTotalCents: 400,
      shippingLines: [{ id: 'L', title: 'FedEx Ground', originalCents: 200, discountedCents: 200 }] });
    assert.equal(orderBeforeChange({ ...order, outstandingCents: 0 }, change), null);
    assert.equal(orderBeforeChange(order, { ...change, to: 'FedEx 2-Days' }), null);
    assert.equal(orderBeforeChange(order, { to: 'FedEx 1-Day' }), null);
  });
});
