import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeExpiryJob } from '../../src/functions/shipping-change-expiry/core.mjs';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const CHANGE = { orderName: 'S1', ref: 'CHG-1', status: 'pending', from: 'FedEx 2-Days', to: 'FedEx 1-Day',
  revertAfter: '2026-09-30T00:00:00Z', restore: { title: 'FedEx 2-Days', priceCents: 12811 } };
const ORDER = { id: 'gid://shopify/Order/1', outstandingCents: 3621,
  shippingLines: [{ id: 'gid://shopify/ShippingLine/5', title: 'FedEx 1-Day' }] };

function run({ changes = [CHANGE], order = ORDER, stage = { ok: true, calculatedOrderId: 'C', outstandingCents: 0 },
  commit = { committed: true } } = {}) {
  const log = { staged: [], committed: [], expired: [], attention: [], chat: [] };
  const job = makeExpiryJob({
    listPending: async () => changes,
    now: () => NOW,
    loadShopifyOrder: async () => order,
    stage: async (p) => { log.staged.push(p); return stage; },
    commit: async (p) => { log.committed.push(p); return commit; },
    markExpired: async (c) => { log.expired.push(c.ref); },
    markAttention: async (c, why) => { log.attention.push(why); },
    notify: async (_n, text) => { log.chat.push(text); return { sent: true }; },
  });
  return job().then((results) => ({ results, log }));
}

describe('expiring unpaid changes', () => {
  test('past revertAfter and unpaid: the paid line goes back, balance cleared', async () => {
    const { results, log } = await run();
    assert.deepEqual(results, [{ orderName: 'S1', ref: 'CHG-1', reverted: true }]);
    assert.deepEqual(log.staged[0], { orderId: 'gid://shopify/Order/1', removeLineId: 'gid://shopify/ShippingLine/5',
      title: 'FedEx 2-Days', priceCents: 12811 });
    assert.deepEqual(log.expired, ['CHG-1']);
    assert.match(log.chat[0], /expired unpaid — reverted/);
  });

  test('not yet due, or not pending: untouched', async () => {
    const { results, log } = await run({ changes: [{ ...CHANGE, revertAfter: '2026-10-02T00:00:00Z' }, { ...CHANGE, status: 'done' }] });
    assert.deepEqual(results, []);
    assert.equal(log.staged.length, 0);
  });

  test('paid but still pending: the webhook was missed — flagged, nothing reverted', async () => {
    const { results, log } = await run({ order: { ...ORDER, outstandingCents: 0 } });
    assert.equal(results[0].flagged, 'paid_not_processed');
    assert.equal(log.committed.length, 0);
  });

  test('someone changed the shipping by hand: flagged', async () => {
    const { results } = await run({ order: { ...ORDER, shippingLines: [{ id: 'x', title: 'FedEx Ground' }] } });
    assert.equal(results[0].flagged, 'shipping_line_changed');
  });

  test('a revert that would not clear the balance exactly: flagged, not committed', async () => {
    const { results, log } = await run({ stage: { ok: true, calculatedOrderId: 'C', outstandingCents: 100 } });
    assert.equal(results[0].flagged, 'revert_leaves_balance');
    assert.equal(log.committed.length, 0);
  });

  test('switch off: not reverted, not marked', async () => {
    const { results, log } = await run({ commit: { committed: false, skipped: 'disabled' } });
    assert.deepEqual(results[0], { orderName: 'S1', ref: 'CHG-1', reverted: false, skipped: 'disabled' });
    assert.equal(log.expired.length, 0);
  });
});
