// fetchOrderByName feeds an access check, so the important case is the one
// where Shopify's search returns something that merely looks right.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fetchOrderByName, toMailingAddress } from '../../src/shared/shopify-orders.mjs';
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

describe('toMailingAddress', () => {
  test('reads the OrderDesk row spelling', () => {
    assert.deepEqual(toMailingAddress({ street: '9 Elm', street2: 'Apt 2', city: 'Reno', state: 'nv', postalCode: '89501', country: 'US' }),
      { address1: '9 Elm', address2: 'Apt 2', city: 'Reno', provinceCode: 'NV', zip: '89501', countryCode: 'US' });
  });

  test('reads the customer form spelling', () => {
    assert.deepEqual(toMailingAddress({ address1: '9 Elm', city: 'Reno', province: 'NV', zip: '89501', country: 'US' }),
      { address1: '9 Elm', city: 'Reno', provinceCode: 'NV', zip: '89501', countryCode: 'US' });
  });

  test('a blank country is the US; a spelled-out one is turned into its code', () => {
    assert.equal(toMailingAddress({ state: 'GA', zip: '30301' }).countryCode, 'US');
    assert.equal(toMailingAddress({ state: 'GA', zip: '30301', country: 'United States' }).countryCode, 'US');
  });

  test('a spelled-out state is refused rather than half-sent', () => {
    assert.equal(toMailingAddress({ state: 'Georgia', zip: '30301' }), null);
    assert.equal(toMailingAddress({ state: 'GA', zip: '' }), null);
  });
});
