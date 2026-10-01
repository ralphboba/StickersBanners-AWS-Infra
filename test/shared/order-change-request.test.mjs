// POST /my-order/request — the only route that commits anything.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeHandler } from '../../src/functions/order-status-api/routes.mjs';

const URL = 'https://stickersbanners.myshopify.com/1234/orders/abcdef0123456789abcdef?key=k';
const ROW = { orderName: 'S1', folderId: '73068', orderStatusUrl: URL, source: { orderDeskId: '49' },
  shipping: { method: 'FedEx 2-Days', state: 'GA' }, items: [{ name: 'X-Banner' }] };
const QUOTE = { ok: true, from: 'FedEx 2-Days', to: 'FedEx 1-Day', shippingCents: 3396, taxCents: 225, totalCents: 3621,
  edit: { orderId: 'gid://shopify/Order/1', calculatedOrderId: 'gid://shopify/CalculatedOrder/9', restore: { title: 'FedEx 2-Days', priceCents: 12811 } } };

function build({ quote = QUOTE, pending = null, commit = { committed: true, outstandingCents: 3621 }, invoice = { sent: true }, writes = true } = {}) {
  const log = { commits: [], saved: [], invoices: [] };
  const deps = {
    loadRow: async (n) => (n === 'S1' ? ROW : undefined),
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
