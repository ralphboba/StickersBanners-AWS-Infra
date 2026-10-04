import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toCents, centsToAmount, centsToDollars } from '../../src/shared/money.mjs';

describe('toCents', () => {
  test('reads the shapes Shopify sends', () => {
    assert.equal(toCents('44.05'), 4405);
    assert.equal(toCents('0.0'), 0);
    assert.equal(toCents('382.2'), 38220);
    assert.equal(toCents('7678.91'), 767891);
    assert.equal(toCents('15'), 1500);
  });

  test('numbers too, without float drift', () => {
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents(128.11), 12811);
    assert.equal(toCents(-3.5), -350);
  });

  test('refuses what it does not understand rather than rounding it', () => {
    for (const v of ['44.055', '1,200.00', '$5', 'abc', '', null, undefined, NaN, Infinity, '1e3']) {
      assert.equal(toCents(v), null, String(v));
    }
  });
});

describe('centsToAmount', () => {
  test('always two decimals', () => {
    assert.equal(centsToAmount(4405), '44.05');
    assert.equal(centsToAmount(0), '0.00');
    assert.equal(centsToAmount(5), '0.05');
    assert.equal(centsToAmount(-350), '-3.50');
  });

  test('refuses a non-integer', () => {
    assert.throws(() => centsToAmount(1.5));
  });

  test('round-trips', () => {
    for (const c of [0, 1, 99, 100, 6106, 767891]) assert.equal(toCents(centsToAmount(c)), c);
    assert.equal(centsToDollars(6106), 61.06);
  });
});
