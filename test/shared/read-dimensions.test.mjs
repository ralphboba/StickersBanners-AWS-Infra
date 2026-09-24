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
  assert.equal(d.rawWidth, '4');
  assert.equal(d.rawHeight, '6');
  // An absent hint and an explicitly-undefined one mean the same thing to
  // resolveDimensions: infer the unit from the SKU, as legacy always has.
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

// --- a unit typed into the value ------------------------------------------
//
// Live on 2026-09-23: order 4978992940, an "8'x8' Step & Repeat Banner Only",
// arrived as `Width (Feet): "96 in"`. The key and the value disagree and the
// value is right — 96 inches IS 8 feet. Read as feet it is 1152 inches, and
// the order was held as implausibly large.
//
// This is the same shape as the SKUAB case that has been open in
// docs/linh-requirements.md: `'48 in' x '80 in'` parsed as 48 feet.

import { unitInValue } from '../../src/shared/orderdesk.mjs';

test('a unit written into the value is recognised', () => {
  for (const [value, expected] of [
    ['96 in', 'in'], ['48 in', 'in'], ['80 inch', 'in'], ['12 inches', 'in'],
    ['6 ft', 'ft'], ['3 feet', 'ft'], ['1 foot', 'ft'],
    ['24"', 'in'], ["3'", 'ft'], ['24 "', 'in'],
  ]) {
    assert.equal(unitInValue(value), expected, `${value} -> ${expected}`);
  }
});

test('a plain number states no unit', () => {
  for (const value of ['5', '5.5', ' 12 ', '', null, undefined, 'Double Sided', 'Sign + H-Stake']) {
    assert.equal(unitInValue(value), undefined, `${JSON.stringify(value)} must not claim a unit`);
  }
});

test('the value beats the key when they disagree', () => {
  assert.deepEqual(
    readDimensions({ 'Width (Feet)': '96 in', 'Height (Feet)': '96 in' }),
    { rawWidth: '96 in', rawHeight: '96 in', unitHint: 'in' });
});

test('the key still decides when the value says nothing', () => {
  assert.equal(readDimensions({ 'Width (Feet)': '5', 'Height (Feet)': '3' }).unitHint, 'ft');
  assert.equal(readDimensions({ 'Width (Inches)': '4', 'Height (Inches)': '4' }).unitHint, 'in');
});

test('the legacy pair honours a unit typed into it — the SKUAB case', () => {
  // This is the one that printed at 12x the intended size.
  assert.deepEqual(
    readDimensions({ WIDTH: '48 in', HEIGHT: '80 in' }),
    { rawWidth: '48 in', rawHeight: '80 in', unitHint: 'in' });
});

test('a plain legacy pair is completely unchanged', () => {
  // The guarantee that matters: orders that parse correctly today must not move.
  const d = readDimensions({ WIDTH: '4', HEIGHT: '6' });
  assert.equal(d.rawWidth, '4');
  assert.equal(d.unitHint, undefined, 'no unit stated means the SKU table still decides');
});

test('4978992940 comes out as 8 feet, not 96', () => {
  const job = cleanOrder({
    source_id: '4978992940',
    id: '901',
    order_metadata: { 'First Rep': 'Shopify' },
    shipping: { state: 'GA', postal_code: '30001' },
    order_items: [{
      code: 'SKUSR08X08', name: "8'x8' Step & Repeat Banner Only", quantity: 1, id: 'LI1',
      variation_list: {
        'Finishing options': 'Pole Pockets (Top and Bottom)',
        'Uploaded File': 'https://cdn.shop/files/step.png',
        'Width (Feet)': '96 in',
        'Height (Feet)': '96 in',
      },
      metadata: {},
    }],
  });
  const item = job.items[0];
  assert.equal(item.unit, 'in');
  assert.equal(item.width, 96);
  assert.equal(item.height, 96);
  // 96 in = 8 ft, comfortably inside the 600 in gate; as feet it was 1152.
  assert.ok(item.width <= 600 && item.height <= 600, 'must no longer read as oversize');
});
