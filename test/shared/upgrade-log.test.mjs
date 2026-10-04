import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { nyDate, nyYesterday, logItem, summarize, dailyMessage } from '../../src/shared/upgrade-log.mjs';

const C = (orderName, to, shippingCents, extra = {}) => ({ orderName, ref: `CHG-${orderName}`, from: 'FedEx Ground', to, shippingCents, taxCents: 0, ...extra });

describe('upgrade log', () => {
  test('days are New York days', () => {
    assert.equal(nyDate(Date.parse('2026-10-04T03:30:00Z')), '2026-10-03');   // 11:30pm EDT
    assert.equal(nyDate(Date.parse('2026-10-04T04:30:00Z')), '2026-10-04');
    assert.equal(nyYesterday(Date.parse('2026-10-04T12:52:00Z')), '2026-10-03');
    assert.equal(nyYesterday(Date.parse('2026-03-01T14:00:00Z')), '2026-02-28');
    assert.equal(nyYesterday(Date.parse('2026-01-01T14:00:00Z')), '2025-12-31');
  });
  test('row key groups by day, never collides', () => {
    const at = Date.parse('2026-10-03T14:02:11Z');
    const i = logItem('paid', C('S1', 'FedEx 3-Days', 1738), at);
    assert.equal(i.PK, 'UPGRADELOG#2026-10-03');
    assert.equal(i.SK, '2026-10-03T14:02:11.000Z#paid#S1#CHG-S1');
    assert.equal(i.test, false);
  });
  test('counts orders, not rows; test orders apart', () => {
    const at = Date.parse('2026-10-03T14:00:00Z');
    const items = [
      logItem('requested', C('S1', 'FedEx 3-Days', 1738), at), logItem('paid', C('S1', 'FedEx 3-Days', 1738), at),
      logItem('paid', C('S1', 'FedEx 3-Days', 1738), at + 1000),          // repeated webhook
      logItem('requested', C('S2', 'FedEx 2-Days', 3386), at), logItem('paid', C('S2', 'FedEx 2-Days', 3386), at),
      logItem('requested', C('S3', 'FedEx 3-Days', 1200), at),            // not paid
      logItem('requested', C('S64262', 'FedEx 1-Day', 7355, { test: true }), at),
      logItem('paid', C('S64262', 'FedEx 1-Day', 7355, { test: true }), at),
    ];
    const s = summarize(items);
    assert.deepEqual(s, { requested: 3, paid: 2, paidShippingCents: 5124, byService: { 'FedEx 3-Days': 1, 'FedEx 2-Days': 1 }, test: 1 });
    assert.equal(dailyMessage('2026-10-03', s),
      'Shipping upgrades Sat, Oct 3: 2 paid · +$51.24 shipping (FedEx 3-Days 1, FedEx 2-Days 1) · 3 requested · 1 test order not counted');
  });
  test('a quiet day still reports', () => {
    assert.equal(dailyMessage('2026-10-05', summarize([])), 'Shipping upgrades Mon, Oct 5: 0 paid · 0 requested');
  });
});
