// OrderDesk rate-limit handling — run with `npm run test:shared`.
//
// Legacy orderDeskWithRetry retries a 429 up to five times, waiting the number
// of seconds the response asks for. Nothing here did that, so one 429 threw and
// lost the whole poll. These pin the retry, the header parsing, and the Lambda
// deadline guard that legacy did not need.

import test from 'node:test';
import assert from 'node:assert/strict';

import { orderDeskFetch, retryAfterMs, orderDeskHeaders } from '../../src/shared/orderdesk-fetch.mjs';

/** A minimal Response stand-in: just a status and headers. */
const reply = (status, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

/** A fetch that returns the queued replies in order, recording each call. */
function fakeFetch(replies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return replies[Math.min(calls.length - 1, replies.length - 1)];
  };
  impl.calls = calls;
  return impl;
}

/** Records what we were asked to sleep instead of actually sleeping. */
function fakeSleep() {
  const waits = [];
  const fn = async (ms) => { waits.push(ms); };
  fn.waits = waits;
  return fn;
}

test('a normal response is returned untouched, with no retry', async () => {
  const f = fakeFetch([reply(200)]);
  const res = await orderDeskFetch('https://x/orders', {}, { fetchImpl: f, sleep: fakeSleep() });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
});

test('non-429 errors come straight back — the caller still handles them', async () => {
  for (const status of [400, 401, 404, 500, 502]) {
    const f = fakeFetch([reply(status)]);
    const res = await orderDeskFetch('https://x/orders', {}, { fetchImpl: f, sleep: fakeSleep() });
    assert.equal(res.status, status);
    assert.equal(f.calls.length, 1, `${status} must not be retried`);
  }
});

test('a 429 is retried and the eventual success is returned', async () => {
  const f = fakeFetch([reply(429, { 'retry-after': '2' }), reply(200)]);
  const sleep = fakeSleep();
  const res = await orderDeskFetch('https://x/orders', {}, { fetchImpl: f, sleep });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleep.waits, [2000]);
});

test('it gives up after the legacy five attempts', async () => {
  const f = fakeFetch([reply(429, { 'retry-after': '1' })]);
  const sleep = fakeSleep();
  await assert.rejects(
    orderDeskFetch('https://x/orders', {}, { fetchImpl: f, sleep }),
    /gave up after 5 attempts/,
  );
  assert.equal(f.calls.length, 5);
  assert.equal(sleep.waits.length, 4, 'no sleep after the final attempt');
});

test('the retry budget stops us being killed mid-sleep', async () => {
  // 30s default wait against a 10s budget: refuse rather than hang the Lambda.
  const f = fakeFetch([reply(429)]);
  const sleep = fakeSleep();
  await assert.rejects(
    orderDeskFetch('https://x/orders', {}, { fetchImpl: f, sleep, budgetMs: 10_000 }),
    /exceeds the 10s retry budget/,
  );
  assert.equal(sleep.waits.length, 0);
});

// --- Retry-After parsing ---------------------------------------------------

test('retryAfterMs reads either header spelling', () => {
  // Legacy reads X-Retry-After; the standard name is Retry-After.
  assert.equal(retryAfterMs(reply(429, { 'retry-after': '5' })), 5000);
  assert.equal(retryAfterMs(reply(429, { 'x-retry-after': '7' })), 7000);
});

test('retryAfterMs falls back to legacy 30s and clamps nonsense', () => {
  assert.equal(retryAfterMs(reply(429)), 30_000, 'absent -> legacy default');
  assert.equal(retryAfterMs(reply(429, { 'retry-after': 'soon' })), 30_000);
  assert.equal(retryAfterMs(reply(429, { 'retry-after': '0' })), 30_000);
  assert.equal(retryAfterMs(reply(429, { 'retry-after': '-5' })), 30_000);
  assert.equal(retryAfterMs(reply(429, { 'retry-after': '99999' })), 60_000, 'clamped');
});

// --- headers ---------------------------------------------------------------

test('orderDeskHeaders carries the store credentials and any extras', () => {
  assert.deepEqual(orderDeskHeaders('784', 'k', { 'Content-Type': 'application/json' }), {
    'ORDERDESK-STORE-ID': '784',
    'ORDERDESK-API-KEY': 'k',
    'Content-Type': 'application/json',
  });
});
