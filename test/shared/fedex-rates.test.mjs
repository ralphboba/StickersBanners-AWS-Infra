// The table is money. These tests check the arithmetic and the edges, and
// re-assert a handful of values straight from the source card so a bad
// regeneration cannot pass quietly.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RATE_BANDS, bandFor, priceOf, quoteUpgrade } from '../../src/shared/fedex-rates.mjs';

describe('the table matches the card', () => {
  test('34 bands, read twice from the PDF', () => {
    assert.equal(RATE_BANDS.length, 34);
  });

  test('spot values from the source', () => {
    assert.deepEqual(RATE_BANDS[0], [1, 37, 15.70, 33.08, 49.56, 89.25, 122.33]);
    assert.deepEqual(RATE_BANDS.at(-1), [9685, 99999, 903, 3825.68, 5461.79, 7678.91, 7711.99]);
    assert.equal(priceOf(150, '2-day'), 128.11);
    assert.equal(priceOf(150, '1-day'), 162.07);
  });

  test('every column climbs with the subtotal, bar one known source anomaly', () => {
    // The $894-968 row prices Saturday Overnight at $870.94 where the pattern
    // every other row follows gives $780.94, so the NEXT row reads as a dip.
    // Kai has it open with FedEx. Exempting exactly this one keeps the check
    // sharp: any new dip still fails.
    const KNOWN_DIP = { col: 6, from: 968 };
    for (let col = 2; col <= 6; col += 1) {
      for (let i = 1; i < RATE_BANDS.length; i += 1) {
        if (col === KNOWN_DIP.col && RATE_BANDS[i][0] === KNOWN_DIP.from) continue;
        assert.ok(RATE_BANDS[i][col] >= RATE_BANDS[i - 1][col],
          `column ${col} dips at band starting $${RATE_BANDS[i][0]}`);
      }
    }
  });

  test('faster is never cheaper, in every band', () => {
    for (const [from, to, ground, d3, d2, d1, sat] of RATE_BANDS) {
      assert.ok(ground <= d3, `$${from}-${to}: ground over 3-day`);
      assert.ok(d3 <= d2, `$${from}-${to}: 3-day over 2-day`);
      assert.ok(d2 <= d1, `$${from}-${to}: 2-day over 1-day`);
      assert.ok(d1 <= sat, `$${from}-${to}: 1-day over Saturday`);
    }
  });

  test('band floors only ever increase, so every subtotal lands in exactly one', () => {
    // The card has one sliver ($98 to $98.01) that belongs to no printed band,
    // which is why bandFor reads floors rather than closed ranges.
    for (let i = 1; i < RATE_BANDS.length; i += 1) {
      assert.ok(RATE_BANDS[i][0] > RATE_BANDS[i - 1][0],
        `floors not increasing at band ${i}`);
    }
  });

  test('the sliver the card leaves open is still priced', () => {
    assert.deepEqual(bandFor(98.005).slice(0, 2), [74, 98]);
    assert.equal(priceOf(98.005, '2-day'), priceOf(90, '2-day'));
  });
});

describe('picking a band', () => {
  test('a boundary belongs to the upper band, once', () => {
    assert.deepEqual(bandFor(37).slice(0, 2), [37, 52]);
    assert.deepEqual(bandFor(36.99).slice(0, 2), [1, 37]);
    assert.deepEqual(bandFor(134).slice(0, 2), [134, 194]);
  });

  test('below the floor still ships, on the first band', () => {
    assert.deepEqual(bandFor(0.5).slice(0, 2), [1, 37]);
    assert.deepEqual(bandFor(0).slice(0, 2), [1, 37]);
  });

  test('above the ceiling returns nothing rather than guessing', () => {
    assert.equal(bandFor(100000), null);
    assert.equal(bandFor(1e9), null);
  });

  test('junk returns nothing — an absent subtotal must not price as the cheapest band', () => {
    for (const v of [null, undefined, NaN, '', 'abc', {}, [], true]) {
      assert.equal(bandFor(v), null, `bandFor(${JSON.stringify(v)}) should be null`);
    }
  });
});

describe('quoting an upgrade', () => {
  test('S59131: $150 subtotal, 2-day to 1-day, is $33.96', () => {
    const q = quoteUpgrade(150, '2-day', '1-day');
    assert.equal(q.amount, 33.96);
    assert.equal(q.fromPrice, 128.11);
    assert.equal(q.toPrice, 162.07);
    assert.deepEqual(q.band, [134, 194]);
  });

  test('it is the difference, never the new price', () => {
    const q = quoteUpgrade(150, '3-day', '2-day');
    assert.equal(q.amount, 41.38);        // 128.11 - 86.73
    assert.notEqual(q.amount, q.toPrice);
  });

  test('the difference does not drift in floating point', () => {
    for (const [from, to, g, d3, d2, d1] of RATE_BANDS) {
      const q = quoteUpgrade(from, '2-day', '1-day');
      if (!q) continue;
      assert.equal(q.amount, Math.round((d1 - d2) * 100) / 100,
        `band $${from}-${to} drifted`);
    }
  });

  test('a downgrade is refused, not quoted as a negative', () => {
    assert.equal(quoteUpgrade(150, '1-day', '2-day'), null);
    assert.equal(quoteUpgrade(150, '2-day', 'Ground'), null);
  });

  test('the same service either way is refused — no $0 invoice', () => {
    assert.equal(quoteUpgrade(150, '2-day', '2-day'), null);
  });

  test('an unknown service is refused', () => {
    assert.equal(quoteUpgrade(150, '2-day', 'teleport'), null);
    assert.equal(quoteUpgrade(150, 'smoke signal', '1-day'), null);
  });

  test('a subtotal off the card is refused', () => {
    assert.equal(quoteUpgrade(100000, '2-day', '1-day'), null);
  });

  test('every spelling in play prices the same column', () => {
    // card / OrderDesk (observed) / legacy
    for (const two of ['2-day', 'FedEx 2-Days', 'FedEx 2-Day', '2-Day Shipping', '2-DAY']) {
      assert.equal(priceOf(150, two), 128.11, `"${two}" should be 2-day`);
    }
    for (const one of ['1-day', 'FedEx 1-Day', '1-Day Economical']) {
      assert.equal(priceOf(150, one), 162.07, `"${one}" should be 1-day`);
    }
    assert.equal(priceOf(150, 'FedEx Ground'), priceOf(150, 'Ground'));
  });

  test('Ground and 3-Day are different services, and the gap is large', () => {
    // $15.70 is the Ground rate only up to a $98 subtotal; by the $134-194
    // band it is $25.67. Quoting from the wrong band is how a customer gets
    // billed the wrong amount, so the band is part of the assertion.
    const q = quoteUpgrade(150, 'FedEx Ground', 'FedEx 3-Days');
    assert.deepEqual(q.band, [134, 194]);
    assert.equal(q.fromPrice, 25.67);
    assert.equal(q.toPrice, 86.73);
    assert.equal(q.amount, 61.06);

    // and at a small subtotal it really is the flat $15.70
    assert.equal(priceOf(50, 'FedEx Ground'), 15.70);
  });
});
