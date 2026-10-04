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

  test('a pickup converted on the order address: the record carries where Order Desk must ship', async () => {
    const PICKUP_ROW = { ...ROW, shipping: { method: 'Georgia Warehouse', state: 'GA' } };
    const TO = { address1: '1 Main', address2: '', city: 'Atlanta', province: 'GA', zip: '30303', country: 'US' };
    const { handler, log } = build({ row: PICKUP_ROW, quote: { ...QUOTE, from: 'Georgia Warehouse', to: 'FedEx Ground', deliverTo: TO },
      commit: { committed: true, outstandingCents: 3621 } });
    const r = await post(handler, { ...OK, service: 'FedEx Ground' });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(log.saved[0].deliverTo, TO);
  });

  test('the balance moved since the page loaded: nothing committed, the new figure returned', async () => {
    const { handler, log } = build({ quote: { ...QUOTE, totalCents: 3622, taxCents: 226 } });
    const { status, body } = read(await post(handler, OK));
    assert.equal(status, 409);
    assert.equal(body.error, 'price_changed');
    assert.equal(body.total, 36.22);
    assert.equal(log.commits.length, 0);
  });

  test('switch off: 503, nothing left pending, no invoice', async () => {
    const { handler, log } = build({ commit: { committed: false, skipped: 'disabled' } });
    assert.equal((await post(handler, OK)).statusCode, 503);
    assert.equal(log.saved.at(-1).status, 'failed');   // the pre-commit record is retired
    assert.equal(log.invoices.length, 0);
  });

  test('the read-only function refuses the route outright', async () => {
    const { handler } = build({ writes: false });
    assert.equal((await post(handler, OK)).statusCode, 503);
  });

  test('Shopify committed a different balance: flagged, no invoice', async () => {
    const { handler, log } = build({ commit: { committed: true, outstandingCents: 3700 } });
    assert.equal((await post(handler, OK)).statusCode, 502);
    assert.equal(log.saved.at(-1).status, 'attention');
    assert.equal(log.invoices.length, 0);
  });

  test('a second click is harmless; a different service is a switch (covered below), never a silent second edit', async () => {
    const pending = { status: 'pending', to: 'FedEx 1-Day', shippingCents: 3396, taxCents: 225 };
    const same = build({ pending });
    assert.deepEqual(read(await post(same.handler, OK)).body, { requested: true, already: true, total: 36.21 });
    assert.equal(same.log.commits.length, 0);
    // a different service while one is pending goes through the switch rules
    // (covered below); here Shopify shows no balance and no line: refused
    const other = build({ pending: { ...pending, to: 'FedEx 2-Days' } });
    assert.equal((await post(other.handler, OK)).statusCode, 409);
    assert.equal(other.log.commits.length, 0);
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
    assert.equal(log.saved.at(-1).paymentUrl, PAY);
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

  test('an order-level refusal offers nothing', async () => {
    const body = JSON.parse((await get(makeHandler(deps({ quote: async () => ({ ok: false, reason: 'price_unverified' }) })))).body);
    assert.equal(body.shipping.canUpgrade, false);
    assert.equal(body.shipping.upgrades.length, 0);
  });

  test('the options are priced at the same time and share one rate cache', async () => {
    const seen = [];
    let inFlight = 0; let maxInFlight = 0;
    const quote = async (a) => {
      seen.push(a.rateCache); inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); inFlight -= 1;
      return { ok: true, to: a.to, shippingCents: 100, taxCents: 0, totalCents: 100, fromCents: 1, toCents: 101 };
    };
    const body = JSON.parse((await get(makeHandler(deps({ quote })))).body);
    assert.equal(body.shipping.upgrades.length, 3);
    assert.equal(maxInFlight, 3);
    assert.ok(seen[0] instanceof Map && seen.every((c) => c === seen[0]));
  });

  test('the quick view (lite=1) answers without asking Shopify anything', async () => {
    const boom = async () => { throw new Error('must not call Shopify'); };
    const h = makeHandler(deps({ loadShopifyOrder: boom, quote: boom }));
    const r = await h({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order',
      queryStringParameters: { o: 'S1', s: URL, lite: '1' } });
    const body = JSON.parse(r.body);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(body.shipping, { current: 'FedEx Ground', lite: true, optionNames: ['FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day'] });
    // the token check still applies
    const bad = await h({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order',
      queryStringParameters: { o: 'S1', s: 'https://evil.example/x', lite: '1' } });
    assert.equal(bad.statusCode, 404);
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
  // Shopify after the customer picked 1-Day and left the payment page (S64262's real figures).
  const SHOPIFY = { name: 'S1', id: 'gid://shopify/Order/1', outstandingCents: 7355, currentTotalCents: 9642, paymentUrl: PAY,
    shippingLines: [{ id: 'gid://shopify/ShippingLine/9', title: 'FedEx 1-Day', originalCents: 8925, discountedCents: 8925 }] };
  const PENDING = { status: 'pending', ref: 'CHG-S1-1', from: 'FedEx Ground', to: 'FedEx 1-Day', shippingCents: 7355, taxCents: 0,
    paymentUrl: PAY, restore: { title: 'FedEx Ground', priceCents: 1570 } };
  const priced = { 'FedEx 3-Days': 1738, 'FedEx 2-Days': 3386, 'FedEx 1-Day': 7355 };
  const build = ({ shopify = SHOPIFY, pending = PENDING, commit, saveFails = false } = {}) => {
    const log = { quotes: [], commits: [], saved: [], order: [] };
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
      commitEdit: async (a) => { log.order.push('commit'); log.commits.push(a); return commit ?? { committed: true, outstandingCents: priced['FedEx 3-Days'], paymentUrl: PAY }; },
      savePending: async (c) => { log.order.push('save'); if (saveFails) throw new Error('ConditionalCheckFailed'); log.saved.push(c); },
      sendInvoice: async () => ({ sent: true }),
      now: () => 1790000000000,
    };
    return { handler: makeHandler(deps), log };
  };
  const get = (h) => h({ requestContext: { http: { method: 'GET', path: '/my-order' } }, rawPath: '/my-order', queryStringParameters: { o: 'S1', s: URL } });
  const SWITCH = { o: 'S1', s: URL, service: 'FedEx 3-Days', expectedTotal: 17.38 };

  test('the page shows every option again, priced from the order before the change', async () => {
    const { handler, log } = build();
    const body = JSON.parse((await get(handler)).body);
    assert.deepEqual(body.shipping.upgrades.map((u) => [u.to, u.total]), [['FedEx 3-Days', 17.38], ['FedEx 2-Days', 33.86], ['FedEx 1-Day', 73.55]]);
    assert.equal(body.shipping.canUpgrade, true);
    assert.equal(body.shipping.current, 'FedEx Ground');
    const o = log.quotes[0].order;
    assert.deepEqual([o.shippingLines[0].title, o.shippingLines[0].originalCents, o.shippingLines[0].id], ['FedEx Ground', 1570, 'gid://shopify/ShippingLine/9']);
    assert.equal(o.outstandingCents, 0);
    assert.equal(o.currentTotalCents, 9642 - 7355);
  });

  test('a different speed: priced like the page, ONE commit, record saved before it and confirmed after', async () => {
    const { handler, log } = build();
    const r = await post(handler, SWITCH);
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), { requested: true, total: 17.38, paymentUrl: PAY });
    assert.deepEqual(log.order, ['save', 'commit', 'save']);
    assert.equal(log.quotes[0].order.shippingLines[0].title, 'FedEx Ground');   // the order before the unpaid change
    assert.equal(log.quotes[0].expectedFrom, 'FedEx Ground');
    assert.deepEqual(log.commits.map((c) => c.calculatedOrderId), ['calc-FedEx 3-Days']);
    assert.match(log.commits[0].staffNote, /replaces unpaid CHG-S1-1, FedEx 1-Day/);
    const [first, last] = log.saved;
    assert.deepEqual([first.to, first.status, first.replaces], ['FedEx 3-Days', 'pending', 'CHG-S1-1']);
    assert.deepEqual([last.to, last.status, last.replaces, last.paymentUrl, last.confirmed], ['FedEx 3-Days', 'pending', first.ref, PAY, true]);
    assert.deepEqual(last.restore, { title: 'FedEx Ground', priceCents: 1570 });
  });

  test('the commit fails: the unpaid record is put back', async () => {
    const { handler, log } = build({ commit: { committed: false, error: 'commit_failed' } });
    assert.equal((await post(handler, SWITCH)).statusCode, 502);
    const back = log.saved[1];
    assert.deepEqual([back.ref, back.to, back.status, back.replaces], ['CHG-S1-1', 'FedEx 1-Day', 'pending', log.saved[0].ref]);
  });

  test('the record changed meanwhile (paid, or another tab): nothing committed', async () => {
    const { handler, log } = build({ saveFails: true });
    const r = await post(handler, SWITCH);
    assert.equal(r.statusCode, 409);
    assert.equal(log.commits.length, 0);
  });

  test('the same speed again just returns the payment page', async () => {
    const { handler, log } = build();
    const r = await post(handler, { ...SWITCH, service: 'FedEx 1-Day', expectedTotal: 73.55 });
    assert.deepEqual(JSON.parse(r.body), { requested: true, already: true, total: 73.55, paymentUrl: PAY });
    assert.equal(log.commits.length, 0);
  });

  test('already paid (webhook not in yet): no switch', async () => {
    const { handler, log } = build({ shopify: { ...SHOPIFY, outstandingCents: 0 } });
    const r = await post(handler, SWITCH);
    assert.equal(r.statusCode, 409);
    assert.equal(JSON.parse(r.body).error, 'already_paid');
    assert.equal(log.commits.length, 0);
  });

  test('a pending record Shopify never received (cut off before the commit) is superseded', async () => {
    const clean = { ...SHOPIFY, outstandingCents: 0, currentTotalCents: 2287,
      shippingLines: [{ id: 'gid://shopify/ShippingLine/9', title: 'FedEx Ground', originalCents: 1570, discountedCents: 1570 }] };
    const { handler, log } = build({ shopify: clean });
    const r = await post(handler, SWITCH);
    assert.equal(r.statusCode, 200);
    assert.equal(log.quotes[0].order, clean);
    assert.equal(log.saved[0].replaces, 'CHG-S1-1');
    assert.doesNotMatch(log.commits[0].staffNote, /replaces unpaid/);
  });

  test('someone changed the Shopify line by hand: no switch', async () => {
    const { handler, log } = build({ shopify: { ...SHOPIFY, shippingLines: [{ ...SHOPIFY.shippingLines[0], title: 'FedEx 2-Days' }] } });
    const r = await post(handler, SWITCH);
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
