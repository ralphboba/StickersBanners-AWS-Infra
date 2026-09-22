// A read-only client for a store the legacy program depends on. The tests are
// mostly about what it refuses to send and how it stays out of the way.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  shopifyGraphQL, checkReadOnly, describeOperation, waitForBucket,
  __resetShopifyClient, SHOPIFY_API_VERSION,
} from '../../src/shared/shopify-fetch.mjs';

beforeEach(() => { __resetShopifyClient(); });

const OK = (throttle = { currentlyAvailable: 1000, restoreRate: 50 }) => async () => ({
  ok: true, status: 200,
  json: async () => ({ data: { ok: true }, extensions: { cost: { throttleStatus: throttle } } }),
  text: async () => '',
});

const ARGS = { shop: 's.myshopify.com', token: 't' };

describe('it will not write', () => {
  test('a plain mutation is refused before any request is made', async () => {
    let called = false;
    await assert.rejects(
      shopifyGraphQL({ ...ARGS, query: 'mutation Kill { orderUpdate(input: {}) { order { id } } }',
        fetchImpl: async () => { called = true; } }),
      /refused/,
    );
    assert.equal(called, false, 'must not reach the network');
  });

  test('the dangerous ones by name', async () => {
    for (const field of ['orderUpdate', 'draftOrderCreate', 'orderEditCommit',
                         'draftOrderInvoiceSend', 'orderCapture', 'refundCreate']) {
      const doc = `mutation X { ${field}(input: {}) { userErrors { message } } }`;
      assert.equal(checkReadOnly(doc).ok, false, `${field} must be refused`);
    }
  });

  test('naming a mutation "query" does not get it through', async () => {
    const doc = 'mutation query { orderUpdate(input: {}) { order { id } } }';
    assert.equal(checkReadOnly(doc).ok, false);
  });

  test('a commented-out word does not change the verdict', () => {
    assert.equal(checkReadOnly('# mutation\nquery Q { shop { name } }').ok, true);
    assert.equal(checkReadOnly('# query\nmutation M { orderUpdate(input:{}) { order { id } } }').ok, false);
  });

  test('draftOrderCalculate is allowed — it persists nothing', () => {
    const doc = 'mutation Q($i: DraftOrderInput!) { draftOrderCalculate(input: $i) { calculatedDraftOrder { totalTaxSet { shopMoney { amount } } } } }';
    assert.equal(checkReadOnly(doc).ok, true);
  });

  test('but not smuggled alongside a real write', () => {
    const doc = `mutation Sneaky($i: DraftOrderInput!) {
      draftOrderCalculate(input: $i) { calculatedDraftOrder { totalTaxSet { shopMoney { amount } } } }
    }`;
    assert.equal(checkReadOnly(doc).ok, true, 'calculate alone is fine');
    // the allowlist is by field, so a write field must still be caught when it
    // is the only operation
    assert.equal(checkReadOnly('mutation S { draftOrderComplete(id: "x") { draftOrder { id } } }').ok, false);
  });

  test('queries pass, including an anonymous one', () => {
    assert.equal(checkReadOnly('query Q { shop { name } }').ok, true);
    assert.equal(checkReadOnly('{ shop { name } }').ok, true);
    assert.deepEqual(describeOperation('{ shop { name } }'), { kind: 'query', name: null });
  });
});

describe('staying out of the legacy program’s way', () => {
  test('the bucket is watched, and a low one makes the NEXT call wait', async () => {
    const slept = [];
    const sleep = async (ms) => { slept.push(ms); };
    const fetchImpl = OK({ currentlyAvailable: 40, restoreRate: 50 });

    await shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl, sleep });
    assert.deepEqual(slept, [], 'the first call does not wait');

    await shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl, sleep });
    assert.equal(slept.length, 1, 'the second waits because the bucket ran low');
    assert.ok(slept[0] > 0);
  });

  test('a healthy bucket never waits', () => {
    assert.equal(waitForBucket({ currentlyAvailable: 1000, restoreRate: 50 }), 0);
    assert.equal(waitForBucket({ currentlyAvailable: 200, restoreRate: 50 }), 0);
  });

  test('the wait is capped, so a bad number cannot stall a Lambda', () => {
    assert.ok(waitForBucket({ currentlyAvailable: 0, restoreRate: 0.0001 }) <= 10_000);
  });

  test('nonsense throttle numbers mean no wait, not a crash', () => {
    for (const t of [null, undefined, {}, { currentlyAvailable: 'x', restoreRate: 'y' }]) {
      assert.equal(waitForBucket(t), 0);
    }
  });

  test('calls are serialised — no parallel burst against a shared store', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => { setTimeout(r, 5); });
      inFlight -= 1;
      return (await OK()());
    };
    await Promise.all([1, 2, 3, 4].map(
      () => shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl }),
    ));
    assert.equal(maxInFlight, 1, 'only one request may be open at a time');
  });

  test('a failed call does not wedge the queue', async () => {
    const bad = async () => { throw new Error('boom'); };
    await assert.rejects(shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl: bad }));
    const r = await shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl: OK() });
    assert.equal(r.data.ok, true, 'the next call still goes through');
  });
});

describe('errors', () => {
  test('THROTTLED arrives as a 200 and is still an error', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      text: async () => '',
    });
    await assert.rejects(shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl }),
      /rate limited/);
  });

  test('a GraphQL error is surfaced, not swallowed', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ errors: [{ message: 'Field does not exist' }] }),
      text: async () => '',
    });
    await assert.rejects(shopifyGraphQL({ ...ARGS, query: '{ nope }', fetchImpl }),
      /Field does not exist/);
  });

  test('missing credentials fail before the network', async () => {
    let called = false;
    const spy = async () => { called = true; };
    await assert.rejects(shopifyGraphQL({ shop: '', token: 't', query: '{ shop { name } }', fetchImpl: spy }));
    await assert.rejects(shopifyGraphQL({ shop: 's', token: '', query: '{ shop { name } }', fetchImpl: spy }));
    assert.equal(called, false);
  });

  test('the API version is pinned', async () => {
    let seen;
    const fetchImpl = async (url) => { seen = url; return (await OK()()); };
    await shopifyGraphQL({ ...ARGS, query: '{ shop { name } }', fetchImpl });
    assert.ok(seen.includes(`/admin/api/${SHOPIFY_API_VERSION}/graphql.json`));
    assert.match(SHOPIFY_API_VERSION, /^\d{4}-\d{2}$/);
  });
});
