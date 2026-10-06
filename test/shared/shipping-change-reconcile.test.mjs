import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeReconciler, paidWithChange, ALERT_AFTER_MS } from '../../src/functions/shipping-change-reconcile/core.mjs';
import { settleChange } from '../../src/functions/shopify-paid/core.mjs';

const T0 = Date.parse('2026-10-06T12:00:00Z');
const CHANGE = { orderName: 'S70001', ref: 'CHG-S70001-1', orderDeskId: '49', from: 'FedEx Ground', to: 'FedEx 3-Days',
  shippingCents: 1738, taxCents: 104, status: 'pending', confirmed: true, committedAt: new Date(T0 - 3600e3).toISOString() };
const PAID = { outstandingCents: 0, shippingLines: [{ title: 'FedEx 3-Days' }] };

function harness({ changes = [CHANGE], order = PAID, apply = { applied: true, from: 'FedEx Ground' }, allowed = { allowed: true },
  now = T0, alertSent = true, claim = true } = {}) {
  const log = { applied: [], done: [], chat: [], alerts: [], seen: [], alerted: [], attention: [], released: 0 };
  const reconcile = makeReconciler({
    now: () => now,
    listOpen: async () => changes,
    shopifyOrder: async () => order,
    markPaidSeen: async (n, r, at) => { log.seen.push([n, at]); },
    markAlerted: async (n, r, at) => { log.alerted.push([n, at]); },
    alert: async (n, text) => { log.alerts.push(text); return { sent: alertSent }; },
    claim: async () => claim,
    release: async () => { log.released += 1; },
    stillAllowed: async () => allowed,
    applyOrderDesk: async (c) => { log.applied.push(c.ref); return apply; },
    markDone: async (n, ref) => { log.done.push(ref); },
    markAttention: async (n, ref, why) => { log.attention.push(why); },
    notify: async (n, text) => { log.chat.push(text); return { sent: true }; },
  });
  return { reconcile, log };
}

describe('paid with the change on the order', () => {
  test('needs both: nothing outstanding AND the new shipping line', () => {
    assert.equal(paidWithChange(PAID, CHANGE), true);
    assert.equal(paidWithChange({ ...PAID, outstandingCents: 1842 }, CHANGE), false);              // not paid yet
    assert.equal(paidWithChange({ outstandingCents: 0, shippingLines: [{ title: 'FedEx Ground' }] }, CHANGE), false); // edit never landed
    assert.equal(paidWithChange(null, CHANGE), false);
  });
});

describe('reconciler', () => {
  test('a paid change the webhook missed is written, marked done, announced', async () => {
    const { reconcile, log } = harness();
    const s = await reconcile();
    assert.deepEqual(log.applied, ['CHG-S70001-1']);
    assert.deepEqual(log.done, ['CHG-S70001-1']);
    assert.equal(log.chat[0], 'S70001 upgraded FedEx Ground → FedEx 3-Days · +$17.38 + $1.04 tax');
    assert.equal(log.alerts.length, 0);
    assert.equal(s.written, 1);
  });

  test('an unpaid change is left alone — no write, no alert', async () => {
    const { reconcile, log } = harness({ order: { ...PAID, outstandingCents: 1842 } });
    await reconcile();
    assert.equal(log.applied.length + log.alerts.length + log.seen.length, 0);
  });

  test('already written by the webhook: a duplicate, nothing announced twice', async () => {
    const { reconcile, log } = harness({ apply: { applied: false, skipped: 'duplicate' } });
    await reconcile();
    assert.deepEqual(log.done, ['CHG-S70001-1']);
    assert.equal(log.chat.length, 0);
    assert.equal(log.alerts.length, 0);
  });

  test('Order Desk failing: retried quietly, then ONE Chat alert after 30 minutes', async () => {
    const fail = { applied: false, error: 'OrderDesk PUT 503' };
    const first = harness({ apply: fail });
    await first.reconcile();
    assert.equal(first.log.alerts.length, 0);
    assert.deepEqual(first.log.seen, [['S70001', T0]]);

    const seen = { ...CHANGE, paidSeenAt: new Date(T0).toISOString() };
    const later = harness({ changes: [seen], apply: fail, now: T0 + ALERT_AFTER_MS });
    await later.reconcile();
    assert.equal(later.log.alerts.length, 1);
    assert.match(later.log.alerts[0], /S70001 PAID \$18\.42 .* still not updated after 30 min \(OrderDesk PUT 503\)/);
    assert.equal(later.log.alerted.length, 1);

    const again = harness({ changes: [{ ...seen, alertedAt: 'x' }], apply: fail, now: T0 + 2 * ALERT_AFTER_MS });
    await again.reconcile();
    assert.equal(again.log.alerts.length, 0);   // once only
  });

  test('a Chat post that fails is not marked, so it is tried again', async () => {
    const seen = { ...CHANGE, paidSeenAt: new Date(T0).toISOString() };
    const { reconcile, log } = harness({ changes: [seen], apply: { applied: false, error: 'x' }, now: T0 + ALERT_AFTER_MS, alertSent: false });
    await reconcile();
    assert.equal(log.alerts.length, 1);
    assert.equal(log.alerted.length, 0);
  });

  test('switches off counts as not applied: alerted, never written', async () => {
    const seen = { ...CHANGE, paidSeenAt: new Date(T0).toISOString() };
    const { reconcile, log } = harness({ changes: [seen], apply: { applied: false, skipped: 'disabled' }, now: T0 + ALERT_AFTER_MS });
    await reconcile();
    assert.match(log.alerts[0], /\(disabled\)/);
  });

  test('paid too late: flagged + announced by the settle step, not alerted again', async () => {
    const { reconcile, log } = harness({ allowed: { allowed: false, reason: 'awaiting_shipment', label: 'Awaiting Shipment' } });
    await reconcile();
    assert.deepEqual(log.attention, ['awaiting_shipment']);
    assert.match(log.chat[0], /NOT applied\. Refund or handle by hand/);
    assert.equal(log.alerts.length, 0);
  });

  test('a flagged change nobody was told about is posted once', async () => {
    const flagged = { ...CHANGE, status: 'attention', attentionReason: 'commit_balance_mismatch' };
    const { reconcile, log } = harness({ changes: [flagged, { ...flagged, orderName: 'S70002', alertedAt: 'x' }] });
    await reconcile();
    assert.equal(log.alerts.length, 1);
    assert.match(log.alerts[0], /S70001 .* needs a person: commit_balance_mismatch/);
    assert.equal(log.applied.length, 0);
  });

  test('a commit still running is not touched; DEMO/ZZ never', async () => {
    const inFlight = { ...CHANGE, confirmed: undefined, committedAt: new Date(T0 - 60e3).toISOString() };
    const { reconcile, log } = harness({ changes: [inFlight, { ...CHANGE, orderName: 'DEMO-1' }] });
    await reconcile();
    assert.equal(log.applied.length, 0);
  });

  test('another settler holds the change: skipped, no alert', async () => {
    const { reconcile, log } = harness({ claim: false });
    await reconcile();
    assert.equal(log.applied.length + log.alerts.length, 0);
  });

  test('one change failing does not stop the others', async () => {
    const applied = [];
    const reconcile = makeReconciler({
      now: () => T0,
      listOpen: async () => [{ ...CHANGE, orderName: 'S70009', ref: 'CHG-9' }, CHANGE],
      shopifyOrder: async (n) => { if (n === 'S70009') throw new Error('boom'); return PAID; },
      markPaidSeen: async () => {}, markAlerted: async () => {}, alert: async () => ({ sent: true }),
      stillAllowed: async () => ({ allowed: true }),
      applyOrderDesk: async (c) => { applied.push(c.ref); return { applied: true }; },
      markDone: async () => {}, markAttention: async () => {}, notify: async () => ({ sent: true }),
    });
    const s = await reconcile();
    assert.deepEqual(applied, ['CHG-S70001-1']);
    assert.equal(s.errors, 1);
  });
});

describe('settleChange claim', () => {
  test('two settlers at once: only the one holding the claim writes', async () => {
    let held = false;
    const applied = [];
    const deps = {
      claim: async () => { if (held) return false; held = true; return true; },
      release: async () => { held = false; },
      stillAllowed: async () => { await new Promise((r) => setTimeout(r, 5)); return { allowed: true }; },
      applyOrderDesk: async (c) => { applied.push(c.ref); return { applied: true }; },
      markDone: async () => {}, markAttention: async () => {}, notify: async () => ({ sent: true }),
    };
    const [a, b] = await Promise.all([settleChange(deps, 'S70001', CHANGE), settleChange(deps, 'S70001', CHANGE)]);
    assert.equal(applied.length, 1);
    assert.deepEqual([a.written, b.reason].sort(), [true, 'in_progress'].sort());
  });
});
