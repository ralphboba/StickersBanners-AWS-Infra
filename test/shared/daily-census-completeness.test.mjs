// A partial census must not read as a pass — run with `npm run test:shared`.
//
// 2026-09-25: the daily routine finished in three minutes, reported no
// problems, and never ran the artwork layer at all (`_census/2026-09-24/` is
// empty). Its conclusion was right, which is the dangerous kind of wrong: the
// same "silent zero" shape as the date filter that returned 0 orders for a full
// day, and as the probe that called a 300 MB file unusable.
//
// The script is read rather than executed here: running it needs AWS. What is
// pinned is that the three ways a run can be incomplete all set `complete:
// false` AND a non-zero exit, so neither a human nor the routine can mistake
// one for a clean day.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = await readFile(new URL('../../scripts/daily-census.mjs', import.meta.url), 'utf8');

test('the report starts incomplete and is only marked complete at the end', () => {
  const declared = SRC.indexOf('complete: false');
  const promoted = SRC.indexOf('report.complete = true');
  assert.ok(declared !== -1, 'the report must default to incomplete');
  assert.ok(promoted !== -1, 'something must promote it');
  assert.ok(declared < promoted, 'the default has to come first');
});

test('every incomplete path also exits non-zero', () => {
  // Three of them: --no-artwork, the probe throwing, and files past the cap.
  const exits = SRC.match(/process\.exitCode = 2/g) ?? [];
  assert.equal(exits.length, 3,
    'each way of finishing early needs its own non-zero exit');
});

test('--no-artwork says what was not checked, not just that it was skipped', () => {
  assert.match(SRC, /--no-artwork\)/);
  assert.match(SRC, /customer files were NOT opened/,
    'the reader has to know which findings are missing, not only that some are');
});

test('a probe failure still prints the layer-1 findings', () => {
  // Losing the gate verdicts because the artwork step failed would be a worse
  // outcome than the incomplete flag it earns.
  const idx = SRC.indexOf('artwork layer FAILED');
  assert.ok(idx !== -1);
  const after = SRC.slice(idx, idx + 400);
  assert.match(after, /console\.log\(JSON\.stringify\(report/,
    'the report must still be printed on a probe failure');
});

test('files past the cap count as incomplete, not as checked', () => {
  assert.match(SRC, /skippedOverCap > 0/);
});

test('B2Sign items are never sent to the artwork probe', () => {
  // Their file is not ours to render, and a verdict on it would be noise in
  // Danny's queue.
  assert.match(SRC, /if \(isB2SignItem\(item\.sku, item\.name\)\) continue;/);
});
