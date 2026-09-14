// There is no password behind this. The token in the link is the whole of the
// access control, so most of these tests are attacks.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseOrderStatusUrl, secretsMatch, authorisesOrder } from '../../src/shared/order-token.mjs';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER = '0f9e8d7c6b5a493827160f5e4d3c2b1a';
const URL_A = `https://stickersbanners.myshopify.com/12345/orders/${TOKEN}?key=abc123`;

describe('parsing', () => {
  test('reads the token from the shapes Shopify actually uses', () => {
    const shapes = [
      `https://s.myshopify.com/12345/orders/${TOKEN}?key=abc123`,
      `https://s.myshopify.com/orders/${TOKEN}`,
      `https://s.myshopify.com/12345/orders/${TOKEN}/authenticate?key=abc123`,
      `https://checkout.shopify.com/12345/orders/${TOKEN}?key=abc123`,
    ];
    for (const u of shapes) {
      assert.equal(parseOrderStatusUrl(u)?.token, TOKEN, `failed on ${u}`);
    }
  });

  test('refuses a host that is not Shopify', () => {
    for (const host of ['evil.com', 'myshopify.com.evil.com', 'notshopify.com']) {
      assert.equal(parseOrderStatusUrl(`https://${host}/orders/${TOKEN}`), null, host);
    }
  });

  test('refuses plain http', () => {
    assert.equal(parseOrderStatusUrl(`http://s.myshopify.com/orders/${TOKEN}`), null);
  });

  test('refuses a token too short to be one', () => {
    for (const t of ['a', 'abc', '123456789012345']) {
      assert.equal(parseOrderStatusUrl(`https://s.myshopify.com/orders/${t}`), null, t);
    }
  });

  test('refuses junk instead of a URL', () => {
    for (const u of ['', null, undefined, 'not a url', '//x', 'javascript:alert(1)']) {
      assert.equal(parseOrderStatusUrl(u), null, String(u));
    }
  });

  test('refuses a URL with no /orders/ segment', () => {
    assert.equal(parseOrderStatusUrl('https://s.myshopify.com/account'), null);
  });
});

describe('comparison', () => {
  test('equal secrets match, different ones do not', () => {
    assert.equal(secretsMatch('abc', 'abc'), true);
    assert.equal(secretsMatch('abc', 'abd'), false);
  });

  test('a prefix is not a match', () => {
    assert.equal(secretsMatch('abc', 'abcdef'), false);
    assert.equal(secretsMatch('abcdef', 'abc'), false);
  });

  test('empty never matches, not even itself', () => {
    assert.equal(secretsMatch('', ''), false);
    assert.equal(secretsMatch(null, null), false);
    assert.equal(secretsMatch(undefined, ''), false);
  });
});

describe('authorisation', () => {
  test('the same link opens the order', () => {
    assert.equal(authorisesOrder(URL_A, URL_A), true);
  });

  test('another order’s link does not', () => {
    const other = URL_A.replace(TOKEN, OTHER);
    assert.equal(authorisesOrder(other, URL_A), false);
  });

  test('the right token with the wrong key does not', () => {
    assert.equal(authorisesOrder(URL_A.replace('abc123', 'wrong'), URL_A), false);
  });

  test('dropping the key does not get past a stored key', () => {
    assert.equal(authorisesOrder(`https://s.myshopify.com/12345/orders/${TOKEN}`, URL_A), false);
  });

  test('a stored URL with no key does not start demanding one', () => {
    const noKey = `https://s.myshopify.com/12345/orders/${TOKEN}`;
    assert.equal(authorisesOrder(noKey, noKey), true);
  });

  test('nothing stored authorises nothing', () => {
    for (const stored of ['', null, undefined]) {
      assert.equal(authorisesOrder(URL_A, stored), false, String(stored));
    }
  });

  test('a token that is merely long does not pass', () => {
    const guess = `https://s.myshopify.com/12345/orders/${'f'.repeat(32)}?key=abc123`;
    assert.equal(authorisesOrder(guess, URL_A), false);
  });
});
