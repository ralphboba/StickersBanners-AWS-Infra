// Line-item sizes the store records under keys legacy never read.
// Run with `npm run test:shared`.
//
// Every fixture here is a real variation_list from 2026-09-22, found by the
// daily census. A key we do not read is not an error — it is width: undefined
// sailing through the intake gate and dying in resize on float(None). That day
// had 11 such line items across 9 orders, 4 of which would have reached print.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readDimensions, resolveDimensions, cleanOrder } from '../../src/shared/orderdesk.mjs';

// --- the legacy pair must be untouched ------------------------------------

test('WIDTH/HEIGHT still wins, and hints nothing', () => {
  const d = readDimensions({ WIDTH: '4', HEIGHT: '6' });
  assert.deepEqual(d, { rawWidth: '4', rawHeight: '6' });
  assert.equal(d.unitHint, undefined, 'the legacy path must keep inferring the unit');
});

test('a newer key never displaces WIDTH/HEIGHT', () => {
  // Both present: legacy is the one the store has always meant.
  const d = readDimensions({ WIDTH: '4', HEIGHT: '6', 'Width (Inches)': '99' });
  assert.equal(d.rawWidth, '4');
  assert.equal(d.unitHint, undefined);
});

test('Width/Height mixed case is shopify-only, as before', () => {
  assert.equal(readDimensions({ Width: '3', Height: '2' }, { shopify: true }).rawWidth, '3');
  assert.equal(readDimensions({ Width: '3', Height: '2' }, { shopify: false }).rawWidth, undefined);
});

// --- the four shapes found in live orders ---------------------------------

test('Width (Feet) / Height (Feet) — S62470-1 item 8, a 5x3ft mesh banner', () => {
  // This is the one that would have printed with no size at all.
  assert.deepEqual(
    readDimensions({ 'Finishing options': 'Pole Pockets (Top Only)', 'Width (Feet)': '5', 'Height (Feet)': '3' }),
    { rawWidth: '5', rawHeight: '3', unitHint: 'ft' });
});

test('Width (Inches) / Height (Inches) — S62506-1, bumper stickers', () => {
  assert.deepEqual(
    readDimensions({ 'Width (Inches)': '4', 'Height (Inches)': '4', 'Material Type': 'x' }),
    { rawWidth: '4', rawHeight: '4', unitHint: 'in' });
});

test('Size (WxH) Inches — S62635-1, a fabric pop-up display', () => {
  // The parenthetical restates the same size in feet. Taking its numbers would
  // turn a 145x91 inch print into a 10x8 one.
  assert.deepEqual(
    readDimensions({ 'Size (WxH) Inches': '145" x 91" (10\' x 8\' Feet)' }),
    { rawWidth: 145, rawHeight: 91, unitHint: 'in' });
});

test('Diameter (Inches) — S62564-1, round stickers', () => {
  // Round still prints on a square of that side; no shape concept is invented.
  assert.deepEqual(
    readDimensions({ 'Diameter (Inches)': '4" Round' }),
    { rawWidth: 4, rawHeight: 4, unitHint: 'in' });
});

test('key case and spacing do not matter', () => {
  assert.equal(readDimensions({ 'WIDTH  (FEET)': '7', 'height (feet)': '2' }).rawWidth, '7');
  assert.equal(readDimensions({ 'WIDTH  (FEET)': '7', 'height (feet)': '2' }).unitHint, 'ft');
});

test('genuinely sizeless products report nothing rather than guessing', () => {
  // Yard signs and feather flags carry no size at all — the size lives in the
  // SKU, which we do not have a table for yet. Inventing one here would be
  // worse than the hold that an absent size produces.
  assert.deepEqual(
    readDimensions({ 'Uploaded File': 'x', Type: 'Sign + H-Stake', Graphic: 'Double Sided' }),
    { rawWidth: undefined, rawHeight: undefined });
  assert.deepEqual(readDimensions({}), { rawWidth: undefined, rawHeight: undefined });
  assert.deepEqual(readDimensions(null), { rawWidth: undefined, rawHeight: undefined });
});

// --- a stated unit beats the inference ------------------------------------

test('a stated unit skips the SKU guess and the nominal-size remaps', () => {
  // Without the hint, 8x8 is remapped to 92x92 inches — that rule exists to
  // catch a size quoted in feet that is really inches. A value the store
  // already labelled "Inches" must not be remapped.
  const guessed = resolveDimensions('SKUVB', 'Custom Vinyl Banners', '8', '8');
  assert.deepEqual(guessed, { width: 92, height: 92, unit: 'in' });

  const stated = resolveDimensions('SKUVB', 'Custom Vinyl Banners', '8', '8', undefined, 'in');
  assert.deepEqual(stated, { width: 8, height: 8, unit: 'in' });
});

test('a stated feet unit is honoured for a SKU the inch table would claim', () => {
  const stated = resolveDimensions('SKUPB', 'Pole Banner', '5', '3', undefined, 'ft');
  assert.deepEqual(stated, { width: 5, height: 3, unit: 'ft' });
});

// --- end to end through cleanOrder ----------------------------------------

test('cleanOrder resolves a Width (Feet) item instead of leaving it undefined', () => {
  const job = cleanOrder({
    source_id: 'S62470-1',
    id: '900',
    order_metadata: { 'First Rep': 'Shopify' },
    shipping: { state: 'GA', postal_code: '30001' },
    order_items: [{
      code: 'SKUMB', name: 'Mesh Banners', quantity: 1, id: 'LI1',
      variation_list: {
        'Finishing options': 'Pole Pockets (Top Only)',
        'Uploaded File': 'https://cdn.shop/files/flag.pdf',
        'Width (Feet)': '5',
        'Height (Feet)': '3',
      },
      metadata: {},
    }],
  });
  const item = job.items[0];
  assert.equal(item.width, 5);
  assert.equal(item.height, 3);
  assert.equal(item.unit, 'ft');
  assert.ok(Number.isFinite(item.width), 'a printable item must have a usable size');
});
