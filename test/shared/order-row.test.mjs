import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeOrderRowLoader } from '../../src/shared/order-row.mjs';

const URL_OK = 'https://stickersbanners.com/94758830375/orders/3e5e64976620c3899853fdcfa788ad70/authenticate?key=shcct_abc';
const URL_API = 'https://stickersbanners.com/94758830375/orders/3e5e64976620c3899853fdcfa788ad70/authenticate?key=8555f836';
const URL_OTHER = 'https://stickersbanners.com/94758830375/orders/ffffffffffffffffffffffffffffffff/authenticate?key=x';
const OD = { id: 1, source_id: 'S66306', folder_id: 652268, order_items: [], shipping: {}, email: 'a@b.c' };

function loader({ row, shopifyUrl = URL_API, od = OD } = {}) {
  const calls = { shopify: 0, orderDesk: 0 };
  const load = makeOrderRowLoader({
    readRow: async () => row,
    shopifyCreds: async () => ({ shop: 's', token: 't' }),
    getSecret: async () => 'x',
    fetchShopify: async () => { calls.shopify += 1; return shopifyUrl ? { statusPageUrl: shopifyUrl } : null; },
    fetchOrderDesk: async () => { calls.orderDesk += 1; return od; },
  });
  return { load, calls };
}

describe('order row for the customer page, in any folder', () => {
  test('a current mirror row is used as is — no live reads', async () => {
    const row = { mirror: true, orderName: 'S1', folderId: '665685', orderStatusUrl: URL_API };
    const { load, calls } = loader({ row });
    assert.equal(await load('S1', URL_OK), row);
    assert.deepEqual(calls, { shopify: 0, orderDesk: 0 });
  });

  test('no row at all (a folder the mirror does not read): read live', async () => {
    const { load, calls } = loader({ row: undefined });
    const got = await load('S66306', URL_OK);
    assert.equal(got.folderId, '652268');
    assert.equal(got.orderStatusUrl, URL_API);
    assert.equal(got.orderName, 'S66306');
    assert.deepEqual(calls, { shopify: 1, orderDesk: 1 });
  });

  test('a row the pipeline claimed is read live, and Order Desk wins', async () => {
    const row = { orderName: 'S66306', status: 'needs_review', folderId: '665685', hold: { reason: 'missing-file' }, shipping: { method: 'old' } };
    const { load } = loader({ row, od: { ...OD, shipping_method: 'FedEx 3-Days' } });
    const got = await load('S66306', URL_OK);
    assert.equal(got.folderId, '652268');
    assert.equal(got.orderStatusUrl, URL_API);
    assert.equal(got.status, 'needs_review');
    assert.deepEqual(got.hold, { reason: 'missing-file' });
  });

  test('a wrong token never reaches Order Desk', async () => {
    const { load, calls } = loader({ row: undefined });
    assert.equal(await load('S66306', URL_OTHER), undefined);
    assert.deepEqual(calls, { shopify: 1, orderDesk: 0 });
  });

  test('something that is not an order-status link costs no lookup at all', async () => {
    const { load, calls } = loader({ row: undefined });
    assert.equal(await load('S66306', 'https://evil.example/orders/3e5e64976620c3899853fdcfa788ad70'), undefined);
    assert.deepEqual(calls, { shopify: 0, orderDesk: 0 });
  });

  test('Shopify or Order Desk failing leaves the stored row (the page refuses, as before)', async () => {
    const { load } = loader({ row: undefined, shopifyUrl: null });
    assert.equal(await load('S66306', URL_OK), undefined);
    const { load: load2 } = loader({ row: undefined, od: null });
    assert.equal(await load2('S66306', URL_OK), undefined);
  });
});
