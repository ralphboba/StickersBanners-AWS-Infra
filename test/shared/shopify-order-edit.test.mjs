import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { stageShippingChange, commitShippingChange, sendBalanceInvoice } from '../../src/shared/shopify-order-edit.mjs';
import { __resetShopifyClient, checkReadOnly, checkWrite, shopifyGraphQL } from '../../src/shared/shopify-fetch.mjs';

beforeEach(() => { __resetShopifyClient(); });
afterEach(() => { delete process.env.SHOPIFY_WRITES; });

const ARGS = { shop: 's.myshopify.com', token: 't' };
const reply = (data) => ({ ok: true, status: 200, text: async () => '',
  json: async () => ({ data, extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } } }) });

describe('staging is not a write', () => {
  test('begin / remove / add pass the read-only guard; commit and invoice do not', () => {
    assert.equal(checkReadOnly('mutation A($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id } } }').ok, true);
    assert.equal(checkReadOnly('mutation A($id: ID!) { orderEditCommit(id: $id) { order { id } } }').ok, false);
    assert.equal(checkReadOnly('mutation A($id: ID!) { orderInvoiceSend(id: $id) { order { id } } }').ok, false);
  });

  test('the write path admits only commit and invoice', () => {
    assert.equal(checkWrite('mutation A($id: ID!) { orderEditCommit(id: $id) { order { id } } }').ok, true);
    assert.equal(checkWrite('mutation A($id: ID!) { orderUpdate(input: {}) { order { id } } }').ok, false);
    assert.equal(checkWrite('mutation A($id: ID!) { orderCancel(orderId: $id) { job { id } } }').ok, false);
  });

  test('the transport refuses a write with the switch off, before any request', async () => {
    let called = false;
    await assert.rejects(shopifyGraphQL({ ...ARGS, write: true, fetchImpl: async () => { called = true; },
      query: 'mutation A($id: ID!) { orderEditCommit(id: $id) { order { id } } }' }), /SHOPIFY_WRITES/);
    assert.equal(called, false);
  });

  test('staging returns Shopify’s balance and checks it against the total', async () => {
    const fetchImpl = async (_u, init) => {
      const q = JSON.parse(init.body).query;
      if (q.includes('EditBegin')) return reply({ orderEditBegin: { userErrors: [], calculatedOrder: { id: 'C1',
        shippingLines: [{ id: 'gid://shopify/CalculatedShippingLine/9', title: 'FedEx Ground', stagedStatus: 'NONE', price: { shopMoney: { amount: '28.3' } } }] } } });
      return reply({ removed: { userErrors: [] }, added: { userErrors: [], calculatedOrder: { id: 'C1',
        totalPriceSet: { shopMoney: { amount: '366.42', currencyCode: 'USD' } },
        totalOutstandingSet: { shopMoney: { amount: '74.25', currencyCode: 'USD' } }, shippingLines: [] } } });
    };
    // S64227, as staged on the live store.
    const r = await stageShippingChange({ ...ARGS, fetchImpl, orderId: 'O', removeLineId: 'gid://shopify/ShippingLine/9',
      title: 'FedEx 3-Days', priceCents: 9647, totalBeforeCents: 29217 });
    assert.deepEqual(r, { ok: true, calculatedOrderId: 'C1', outstandingCents: 7425, totalCents: 36642 });
  });
});

describe('commit and invoice', () => {
  test('refused while SHOPIFY_WRITES is off, and for DEMO-/ZZ- orders even when on', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return reply({}); };
    assert.equal((await commitShippingChange({ ...ARGS, fetchImpl, orderName: 'S1', calculatedOrderId: 'C' })).skipped, 'disabled');
    assert.equal((await sendBalanceInvoice({ ...ARGS, fetchImpl, orderName: 'S1', orderId: 'O' })).skipped, 'disabled');
    process.env.SHOPIFY_WRITES = 'enabled';
    assert.equal((await commitShippingChange({ ...ARGS, fetchImpl, orderName: 'DEMO-1', calculatedOrderId: 'C' })).skipped, 'synthetic');
    assert.equal(called, false);
  });

  test('commit reports the balance left on the order', async () => {
    process.env.SHOPIFY_WRITES = 'enabled';
    const fetchImpl = async () => reply({ orderEditCommit: { userErrors: [], order: { id: 'O', name: 'S1',
      displayFinancialStatus: 'PARTIALLY_PAID', currentTotalPriceSet: { shopMoney: { amount: '40.25' } },
      totalOutstandingSet: { shopMoney: { amount: '33.08' } } } } });
    assert.deepEqual(await commitShippingChange({ ...ARGS, fetchImpl, orderName: 'S1', calculatedOrderId: 'C' }),
      { committed: true, financialStatus: 'PARTIALLY_PAID', outstandingCents: 3308, totalCents: 4025 });
  });
});
