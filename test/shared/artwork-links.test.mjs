// Upload links the store actually emits — run with `npm run test:shared`.
//
// All three were found on 2026-09-26 by asking "which orders came in without
// artwork?" and then opening each one. Ten orders said missing-file; six of
// them had files. Legacy has every one of these bugs too (same code), so these
// are fixes, not ports.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOrder } from '../../src/shared/orderdesk.mjs';
import { intakeGate } from '../../src/shared/intake-gate.mjs';

const BASE = 'https://sticker-banner-large-file-uploads.s3.eu-north-1.amazonaws.com/2026-09-26/1790449024597';

function shopifyOrder(variationList, { sourceId = 'S63815', code = 'SKUVB', name = 'Custom Vinyl Banners' } = {}) {
  return cleanOrder({
    source_id: sourceId,
    id: '1',
    order_metadata: { 'First Rep': 'Shopify' },
    shipping: { state: 'GA', postal_code: '30001' },
    order_items: [{
      code, name, quantity: 1, id: 'L1',
      variation_list: { WIDTH: '6', HEIGHT: '3', 'FINISHING OPTIONS': 'Hem & Grommets', ...variationList },
      metadata: {},
    }],
  });
}

// --- a `#` in the customer's file name ------------------------------------

test('a # in the file name is part of the name, not a fragment', () => {
  // S63815: 18 banners, 18 good .jpg files, every one named "... #N.jpg".
  const job = shopifyOrder({ 'UPLOADED FILE': `${BASE}/CHES 8th Grade Night Banner #6.jpg` });
  const item = job.items[0];
  assert.equal(item.artworkExt, 'jpg');
  assert.equal(job.flags.isMissingFile, false);
  assert.equal(intakeGate(job), null, 'a banner with a real file must be processed');
});

test('the download url keeps the whole file name', () => {
  // Fixing only the extension would let the order clear the gate and then
  // request `.../Banner%20` in resize — a 403. Verified live: the escaped url
  // returns 206 image/jpeg, the truncated one 403.
  const job = shopifyOrder({ 'UPLOADED FILE': `${BASE}/CHES 8th Grade Night Banner #6.jpg` });
  const url = job.items[0].artworkUrl;
  assert.ok(url.endsWith('Banner%20%236.jpg'), url);
  assert.ok(!url.includes('#'), 'no raw # may survive into the url');
  assert.equal(new URL(url).hash, '', 'nothing may be parsed as a fragment');
});

test('several # in one name all survive', () => {
  const job = shopifyOrder({ 'UPLOADED FILE': `${BASE}/Team #1 vs #2 final.png` });
  assert.equal(job.items[0].artworkExt, 'png');
  assert.ok(job.items[0].artworkUrl.endsWith('Team%20%231%20vs%20%232%20final.png'));
});

test('an ordinary url is unchanged', () => {
  const job = shopifyOrder({ 'Uploaded File': `${BASE}/banner.pdf` });
  assert.equal(job.items[0].artworkUrl, `${BASE}/banner.pdf`);
  assert.equal(job.items[0].artworkExt, 'pdf');
});

// --- numbered uploads in upper case -----------------------------------------

test('UPLOADED FILE 1..N is several files, not none', () => {
  // S63808 (3 files), S63777 and S63752 (5 each) all reported missing-file.
  const job = shopifyOrder({
    'UPLOADED FILE 1': `${BASE}/a.jpeg`,
    'UPLOADED FILE 2': `${BASE}/b.jpeg`,
    'UPLOADED FILE 3': `${BASE}/c.jpeg`,
  });
  assert.equal(job.flags.hasMultipleFiles, true);
  assert.equal(job.flags.isMissingFile, false);
  assert.equal(intakeGate(job).reason, 'multiple-files');
  assert.equal(intakeGate(job).folder, 'sales');
});

test('mixed-case numbered uploads still work as before', () => {
  const job = shopifyOrder({ 'Uploaded File 1': `${BASE}/a.png`, 'Uploaded File 2': `${BASE}/b.png` });
  assert.equal(job.flags.hasMultipleFiles, true);
});

test('a genuinely empty upload is still missing-file', () => {
  // The fix must not turn "no file" into anything else.
  const job = shopifyOrder({});
  assert.equal(job.flags.isMissingFile, true);
  assert.equal(job.flags.hasMultipleFiles, false);
  assert.equal(intakeGate(job).reason, 'missing-file');
});

test('a key that merely contains "uploaded file" and a number is not a match', () => {
  // Anchored: only `Uploaded File <n>` counts, not free text around it.
  const job = shopifyOrder({ 'Notes about uploaded file 2 please': 'x' });
  assert.equal(job.flags.hasMultipleFiles, false);
  assert.equal(job.flags.isMissingFile, true);
});
