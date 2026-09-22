// fetchOrderByName feeds an access check, so the important case is the one
// where Shopify's search returns something that merely looks right.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchOrderByName, quoteUpgradeWithTax } from '../../src/shared/shopify-orders.mjs';
import { __resetShopifyClient } from '../../src/shared/shopify-fetch.mjs';

beforeEach(() => { __resetShopifyClient(); });

const reply = (data) => async () => ({
  ok: true, status: 200,
  json: async () => ({ data, extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } } }),
  text: async () => '',
});

const order = (name) => ({
  id: `gid://shopify/Order/${name}`,
  name,
  statusPageUrl: `https://s.myshopify.com/1/orders/${name}tokentokentoken?key=k`,
  currentSubtotalPriceSet: { shopMoney: { amount: '150.00', currencyCode: 'USD' } },
});

const ARGS = { shop: 's.myshopify.com', token: 't' };

describe('fetchOrderByName', () => {
  test('one exact match comes back', async () => {
    const r = await fetchOrderByName({ ...ARGS, orderName: 'S59131',
      fetchImpl: reply({ orders: { nodes: [order('S59131')] } }) });
    assert.equal(r.name, 'S59131');
    assert.ok(r.statusPageUrl.includes('/orders/'));
    assert.equal(r.subtotal, 150);
  });

  test('a Shopify name carrying the # still matches', async () => {
    const r = await fetchOrderByName({ ...ARGS, orderName: 'S59131',
      fetchImpl: reply({ orders: { nodes: [order('#S59131')] } }) });
    assert.equal(r.name, '#S59131');
  });

  test('a prefix match is NOT accepted as the order', async () => {
    // Shopify's query: is a search. Asking for S5913 can return S59131.
    const r = await fetchOrderByName({ ...ARGS, orderName: 'S5913',
      fetchImpl: reply({ orders: { nodes: [order('S59131')] } }) });
    assert.equal(r, null, 'a near miss must not authorise an order');
  });

  test('two exact matches is a refusal, not a coin toss', async () => {
    const r = await fetchOrderByName({ ...ARGS, orderName: 'S59131',
      fetchImpl: reply({ orders: { nodes: [order('S59131'), order('S59131')] } }) });
    assert.equal(r, null);
  });

  test('nothing found is null', async () => {
    const r = await fetchOrderByName({ ...ARGS, orderName: 'S00000',
      fetchImpl: reply({ orders: { nodes: [] } }) });
    assert.equal(r, null);
  });

  test('an empty name never reaches the network', async () => {
    let called = false;
    const spy = async () => { called = true; };
    for (const n of ['', '   ', null, undefined]) {
      assert.equal(await fetchOrderByName({ ...ARGS, orderName: n, fetchImpl: spy }), null);
    }
    assert.equal(called, false);
  });

  test('the name is sent quoted, so a dash does not split it', async () => {
    let sent;
    const fetchImpl = async (_u, init) => {
      sent = JSON.parse(init.body);
      return (await reply({ orders: { nodes: [order('S23766-2-M')] } })());
    };
    await fetchOrderByName({ ...ARGS, orderName: 'S23766-2-M', fetchImpl });
    assert.equal(sent.variables.q, 'name:"S23766-2-M"');
  });

  test('a missing statusPageUrl comes back as null, not undefined chaos', async () => {
    const o = { ...order('S59131'), statusPageUrl: null };
    const r = await fetchOrderByName({ ...ARGS, orderName: 'S59131',
      fetchImpl: reply({ orders: { nodes: [o] } }) });
    assert.equal(r.statusPageUrl, null);
  });
});

describe('quoteUpgradeWithTax', () => {
  const calc = (subtotal, tax, total) => reply({
    draftOrderCalculate: {
      calculatedDraftOrder: {
        subtotalPriceSet: { shopMoney: { amount: subtotal } },
        totalTaxSet: { shopMoney: { amount: tax } },
        totalPriceSet: { shopMoney: { amount: total } },
      },
      userErrors: [],
    },
  });

  test('returns Shopify’s own numbers', async () => {
    const r = await quoteUpgradeWithTax({ ...ARGS, title: 'Shipping Upgrade', amount: 33.96,
      fetchImpl: calc('33.96', '2.72', '36.68') });
    assert.deepEqual(r, { subtotal: 33.96, tax: 2.72, total: 36.68 });
  });

  test('no tax at this address is a real answer, not a missing one', async () => {
    const r = await quoteUpgradeWithTax({ ...ARGS, title: 'x', amount: 33.96,
      fetchImpl: calc('33.96', '0.00', '33.96') });
    assert.deepEqual(r, { subtotal: 33.96, tax: 0, total: 33.96 });
  });

  test('a partial answer is refused — that is how tax goes missing from a quote', async () => {
    const partial = reply({
      draftOrderCalculate: {
        calculatedDraftOrder: {
          subtotalPriceSet: { shopMoney: { amount: '33.96' } },
          totalTaxSet: null,
          totalPriceSet: { shopMoney: { amount: '36.68' } },
        },
        userErrors: [],
      },
    });
    assert.equal(await quoteUpgradeWithTax({ ...ARGS, title: 'x', amount: 33.96, fetchImpl: partial }), null);
  });

  test('userErrors mean no quote', async () => {
    const bad = reply({ draftOrderCalculate: { calculatedDraftOrder: null,
      userErrors: [{ field: ['input'], message: 'nope' }] } });
    assert.equal(await quoteUpgradeWithTax({ ...ARGS, title: 'x', amount: 33.96, fetchImpl: bad }), null);
  });

  test('a non-positive amount never reaches the network', async () => {
    let called = false;
    const spy = async () => { called = true; };
    for (const a of [0, -1, null, undefined, NaN]) {
      assert.equal(await quoteUpgradeWithTax({ ...ARGS, title: 'x', amount: a, fetchImpl: spy }), null);
    }
    assert.equal(called, false);
  });

  test('the line is marked taxable and non-shipping, so tax is actually computed', async () => {
    let sent;
    const fetchImpl = async (_u, init) => {
      sent = JSON.parse(init.body);
      return (await calc('33.96', '2.72', '36.68')());
    };
    await quoteUpgradeWithTax({ ...ARGS, title: 'Shipping Upgrade', amount: 33.96,
      customerId: 'gid://shopify/Customer/1', fetchImpl });
    const line = sent.variables.input.lineItems[0];
    assert.equal(line.taxable, true);
    assert.equal(line.requiresShipping, false);
    assert.equal(line.originalUnitPrice, '33.96');
    assert.equal(sent.variables.input.purchasingEntity.customerId, 'gid://shopify/Customer/1');
  });
});
