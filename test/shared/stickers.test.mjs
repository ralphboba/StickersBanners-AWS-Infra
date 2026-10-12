// Stickers we make ourselves (Kai, 2026-10-12): round, oval and bumper.
// Custom Shape Kiss-Cut stays with a person.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOrder } from '../../src/shared/orderdesk.mjs';
import { intakeGate } from '../../src/shared/intake-gate.mjs';
import { stickerDpi, stickerSpec } from '../../src/shared/sku-config.mjs';

const order = (name, code, vl, { qty = 25, state = 'NV', method = 'FedEx Ground', extra = [] } = {}) => cleanOrder({
  source_id: 'S1',
  shipping: { state },
  shipping_method: method,
  order_items: [
    { id: 1, name, code, quantity: qty, variation_list: { SKU: code, 'UPLOADED FILE': 'https://x/a.png', ...vl } },
    ...extra,
  ],
});

test('round and oval sizes come from the SKU, in inches', () => {
  // The order says "2 x 2" -- feet, if read the banner way.
  const round = order('Round Stickers', 'SKU-466', { WIDTH: '2', HEIGHT: '2' }).items[0];
  assert.deepEqual([round.width, round.height, round.unit], [2, 2, 'in']);
  assert.deepEqual(round.sticker, { shape: 'circle', dpi: 1000 });

  const oval = order('Oval Stickers', 'SKU-471', { WIDTH: '3', HEIGHT: '2' }).items[0];
  assert.deepEqual([oval.width, oval.height, oval.unit], [3, 2, 'in']);
  assert.equal(oval.sticker.shape, 'oval');
});

test('bumper stickers take the ordered size, in inches, with no banner remaps', () => {
  // 4x4 and 8x8 are remapped to 46 / 92 inches for banners. Not for a sticker.
  const b4 = order('Bumper Stickers', 'SKUVS', { WIDTH: '4', HEIGHT: '4' }).items[0];
  assert.deepEqual([b4.width, b4.height, b4.unit], [4, 4, 'in']);
  const b8 = order('Bumper Stickers', 'SKUVS', { WIDTH: '8', HEIGHT: '8' }).items[0];
  assert.deepEqual([b8.width, b8.height, b8.unit], [8, 8, 'in']);
  assert.equal(b8.sticker.shape, 'rect');
});

test('a round sticker on the bumper SKU is cut round, at the ordered size', () => {
  // S65535: "ROUND STICKERS", SKU SKUVS, 5 x 5 -- the office cut it round.
  const round = order('ROUND STICKERS', 'SKUVS', { WIDTH: '5', HEIGHT: '5' }).items[0];
  assert.deepEqual([round.width, round.height, round.unit], [5, 5, 'in']);
  assert.deepEqual(round.sticker, { shape: 'circle', dpi: 650 });
  // A bumper sticker stays a bumper sticker.
  assert.equal(order('Bumper Stickers', 'SKUVS', { WIDTH: '5', HEIGHT: '5' }).items[0].sticker.shape, 'rect');
  assert.equal(stickerSpec('SKUVS', 'Round Stickers').shape, 'circle');
  assert.equal(stickerSpec('SKU-471', 'Round Stickers').shape, 'oval'); // only the bumper SKU follows the name
});

test('resolution: smaller than 5x5 is 1000, anything else 650', () => {
  assert.equal(stickerDpi(2, 2), 1000);
  assert.equal(stickerDpi(4.9, 4.9), 1000);
  assert.equal(stickerDpi(5, 2), 1000); // fits inside 5x5 and is smaller
  assert.equal(stickerDpi(5, 5), 650);
  assert.equal(stickerDpi(6, 3), 650);
  assert.equal(stickerDpi(11, 3), 650);
});

test('our stickers are processed; kiss-cut still goes to a person', () => {
  const round = order('Round Stickers', 'SKU-467', { WIDTH: '3', HEIGHT: '3' });
  assert.equal(round.flags.hasSpecialProduct, false);
  assert.equal(intakeGate(round), null);

  const kiss = order('Custom Shape Kiss-Cut Stickers', 'SKUDC', { WIDTH: '2', HEIGHT: '2' });
  assert.equal(kiss.flags.hasSpecialProduct, true);
  assert.equal(intakeGate(kiss).reason, 'special-product');
  assert.equal(stickerSpec('SKUDC'), null);

  // An order with a kiss-cut line is held whole, even next to a round sticker.
  const mixed = order('Round Stickers', 'SKU-466', { WIDTH: '2', HEIGHT: '2' }, {
    extra: [{ id: 2, name: 'Custom Shape Kiss-Cut Stickers', code: 'SKUDC', quantity: 50,
      variation_list: { SKU: 'SKUDC', WIDTH: '2', HEIGHT: '2', 'UPLOADED FILE': 'https://x/b.png' } }],
  });
  assert.equal(intakeGate(mixed).reason, 'special-product');
});

test('a sticker order prints in GA wherever it ships, pickup included', () => {
  assert.equal(order('Bumper Stickers', 'SKUVS', { WIDTH: '11', HEIGHT: '3' }, { state: 'NV' }).routing.facility, 'GA');
  assert.equal(order('Bumper Stickers', 'SKUVS', { WIDTH: '11', HEIGHT: '3' }, { state: 'NJ' }).routing.pickupStatus, 'pickup_ga');
  assert.equal(order('Oval Stickers', 'SKU-471', {}, { state: 'TX', method: 'Texas Warehouse pickup' }).routing.facility, 'GA');
  // A banner on its own still routes by address.
  assert.equal(order('Custom Vinyl Banners', 'SKUVB', { WIDTH: '3', HEIGHT: '2' }, { state: 'NV' }).routing.facility, 'NV');
});
