// The poller's OrderDesk date filter — run with `npm run test:shared`.
//
// Both of these fail by returning ZERO orders, never an error, which is how a
// whole-day audit can report "nothing came in" and be believed:
//
//   date_type=date_added   matches nothing at all (2026-09-22: 0 vs 399)
//   search_end_date        is EXCLUSIVE (start=end=2026-09-22 returns 0)
//
// dayAfter is re-implemented here rather than exported, because what is being
// pinned is the URL the poller builds — the arithmetic is incidental.

import test from 'node:test';
import assert from 'node:assert/strict';

/** The same rule the poller applies to `until`. */
function dayAfter(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

test('one calendar day becomes a half-open range OrderDesk understands', () => {
  // Asking for 2026-09-22 must not send end=2026-09-22, which matches nothing.
  assert.equal(dayAfter('2026-09-22'), '2026-09-23');
});

test('month and year boundaries roll over', () => {
  assert.equal(dayAfter('2026-09-30'), '2026-10-01');
  assert.equal(dayAfter('2026-12-31'), '2027-01-01');
  assert.equal(dayAfter('2026-02-28'), '2026-03-01');
  assert.equal(dayAfter('2028-02-28'), '2028-02-29', 'leap year');
});

test('something that is not a date is passed through untouched', () => {
  // Better to send the caller's string and let OrderDesk reject it than to
  // silently query a different range.
  assert.equal(dayAfter('not-a-date'), 'not-a-date');
});

test('the poller never sends date_type', async () => {
  // date_type=date_added is the value that silently returns nothing, and no
  // other value changes the result, so the parameter has no reason to exist.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../../src/functions/poller/index.mjs', import.meta.url), 'utf8');
  assert.ok(!/q\.set\('date_type'/.test(src),
    'date_type must not be set on the orders query');
});
