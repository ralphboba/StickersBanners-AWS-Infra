import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { makePaidHandler, verifyShopifyHmac } from '../../src/functions/shopify-paid/core.mjs';

const SECRET = 'shh';
const sign = (raw) => crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64');
const event = (payload, { topic = 'orders/paid', hmac } = {}) => {
  const raw = JSON.stringify(payload);
  return { body: raw, headers: { 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': hmac ?? sign(raw) } };
};
const CHANGE = { orderName: 'S64262', ref: 'CHG-1', orderDeskId: '49', from: 'FedEx Ground', to: 'FedEx 3-Days',
  shippingCents: 1738, taxCents: 104, status: 'pending' };

function harness({ change = CHANGE, apply = { applied: true, from: 'FedEx Ground' }, allowed = { allowed: true } } = {}) {
  const log = { applied: [], done: [], chat: [], attention: [] };
  const handler = makePaidHandler({
    webhookSecret: async () => SECRET,
    loadPending: async (name) => (change && name === change.orderName ? change : null),
    markDone: async (name, ref) => { log.done.push([name, ref]); },
    markAttention: async (name, ref, why) => { log.attention.push([name, ref, why]); },
    stillAllowed: async () => allowed,
    applyOrderDesk: async (c) => { log.applied.push(c.ref); return apply; },
    notify: async (name, text) => { log.chat.push(text); return { sent: true }; },
  });
  return { handler, log };
}
const body = (r) => JSON.parse(r.body);

describe('orders/paid', () => {
  test('a paid order with a pending change: Order Desk, then done, then Chat', async () => {
    const { handler, log } = harness();
    const r = await handler(event({ name: '#S64262', financial_status: 'paid' }));
    assert.equal(r.statusCode, 200);
    assert.deepEqual(body(r), { written: true, duplicate: false, chat: true });
    assert.deepEqual(log.applied, ['CHG-1']);
    assert.deepEqual(log.done, [['S64262', 'CHG-1']]);
    assert.deepEqual(log.chat, ['S64262 upgraded FedEx Ground → FedEx 3-Days · +$17.38 + $1.04 tax']);
  });

  test('a bad signature is refused before anything is read', async () => {
    const { handler, log } = harness();
    const r = await handler(event({ name: 'S64262', financial_status: 'paid' }, { hmac: sign('other') }));
    assert.equal(r.statusCode, 401);
    assert.equal(log.applied.length, 0);
  });

  test('every other paid order is ignored', async () => {
    const { handler, log } = harness();
    assert.equal(body(await handler(event({ name: 'S1', financial_status: 'paid' }))).ignored, 'no_pending_change');
    assert.equal(body(await handler(event({ name: 'S64262', financial_status: 'partially_paid' }))).ignored, 'not_paid');
    assert.equal(body(await handler(event({ name: 'S64262', financial_status: 'paid' }, { topic: 'orders/create' }))).ignored, 'topic');
    assert.equal(log.applied.length, 0);
  });

  test('a repeated webhook changes nothing and announces nothing', async () => {
    const { handler, log } = harness({ apply: { applied: false, skipped: 'duplicate' } });
    const r = body(await handler(event({ name: 'S64262', financial_status: 'paid' })));
    assert.equal(r.duplicate, true);
    assert.equal(log.chat.length, 0);
    const done = harness({ change: { ...CHANGE, status: 'done' } });
    assert.equal(body(await done.handler(event({ name: 'S64262', financial_status: 'paid' }))).ignored, 'already_done');
    assert.equal(done.log.applied.length, 0);
  });

  test('an Order Desk failure asks Shopify to retry and tells nobody', async () => {
    const { handler, log } = harness({ apply: { applied: false, error: 'OrderDesk PUT 500' } });
    const r = await handler(event({ name: 'S64262', financial_status: 'paid' }));
    assert.equal(r.statusCode, 500);
    assert.equal(log.done.length, 0);
    assert.equal(log.chat.length, 0);
  });

  test('paid too late: nothing written, the team is told a refund is needed', async () => {
    const { handler, log } = harness({ allowed: { allowed: false, reason: 'ground_after_production', label: 'Ready to ship' } });
    const r = body(await handler(event({ name: 'S64262', financial_status: 'paid' })));
    assert.deepEqual(r, { written: false, reason: 'too_late', detail: 'ground_after_production' });
    assert.equal(log.applied.length, 0);
    assert.deepEqual(log.attention, [['S64262', 'CHG-1', 'ground_after_production']]);
    assert.equal(log.chat.length, 1);
    assert.match(log.chat[0], /^S64262 PAID for FedEx Ground → FedEx 3-Days \(\+\$18\.42\) but the order is now Ready to ship — NOT applied\. Refund/);
  });

  test('a flagged change is not flagged again on a repeat webhook', async () => {
    const { handler, log } = harness({ change: { ...CHANGE, status: 'attention' } });
    assert.equal(body(await handler(event({ name: 'S64262', financial_status: 'paid' }))).ignored, 'already_flagged');
    assert.equal(log.chat.length, 0);
  });

  test('verifyShopifyHmac rejects anything missing', () => {
    assert.equal(verifyShopifyHmac('x', '', SECRET), false);
    assert.equal(verifyShopifyHmac('', sign(''), SECRET), false);
    assert.equal(verifyShopifyHmac('x', sign('x'), ''), false);
    assert.equal(verifyShopifyHmac('x', sign('x'), SECRET), true);
  });
});
