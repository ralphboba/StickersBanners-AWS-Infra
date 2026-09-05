// Intake parsing tests — run with `npm run test:shared` (node --test).
//
// These pin the behaviour that must match the legacy SBBotExpress order
// classes. Legacy picks between two of them by order source, and they are not
// interchangeable, so most cases here assert the *Shopify* path (what every
// real S##### order runs) and a few assert the QTS path still differs where
// legacy differs.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanOrder, orderVariant, resolveDimensions, getFinishMode, getFinishObj,
  getGrommetsCount2, getSingleSideGrommetsCount, SHOPIFY, QTS,
} from '../../src/shared/orderdesk.mjs';

const ART = 'https://cdn.shop/files/art.pdf';

/** An OrderDesk order shaped like the live store's Shopify orders. */
function order({ sku = 'SKUVB', name = 'Custom Vinyl Banner', W = 6, H = 5,
                 finish = 'Hem & Grommets', qty = 1, vl = {}, metadata = {},
                 sourceId = 'S56001', firstRep } = {}) {
  return {
    source_id: sourceId,
    id: '900',
    date_added: '2026-01-01T00:00:00Z',
    email: 'cx@example.com',
    shipping: { state: 'GA', postal_code: '30001', first_name: 'A', last_name: 'B' },
    ...(firstRep ? { order_metadata: { 'First Rep': firstRep } } : {}),
    order_items: [{
      code: sku, name, quantity: qty, id: 'LI1',
      variation_list: {
        WIDTH: String(W), HEIGHT: String(H), 'FINISHING OPTIONS': finish,
        'Uploaded File': ART, ...vl,
      },
      metadata,
    }],
  };
}
const firstItem = (o) => cleanOrder(o).items[0];

// --- which legacy class handles the order ----------------------------------

test('orderVariant: real store orders (S…) take the Shopify path', () => {
  assert.equal(orderVariant({ source_id: 'S56001' }), SHOPIFY);
  assert.equal(orderVariant({ source_id: 'X1', order_metadata: { 'First Rep': 'Shopify' } }), SHOPIFY);
  assert.equal(orderVariant({ source_id: '4823801586' }), QTS);
  assert.equal(orderVariant({}), QTS);
});

// --- dimensions (legacy getUnit) -------------------------------------------

test('resolveDimensions: legacy nominal-size remap', () => {
  assert.deepEqual(resolveDimensions('SKUVB', 'Custom Vinyl Banner', '6', '5'),
    { width: 6, height: 5, unit: 'ft' });
  assert.deepEqual(resolveDimensions('SKUVB', 'Custom Vinyl Banner', '8', '8'),
    { width: 92, height: 92, unit: 'in' });
  assert.deepEqual(resolveDimensions('SKUVB', 'Custom Vinyl Banner', '10', '8'),
    { width: 120, height: 92, unit: 'in' });
  assert.deepEqual(resolveDimensions('SKUVB', 'Custom Vinyl Banner', '4', '4'),
    { width: 46, height: 46, unit: 'in' });
});

test('resolveDimensions: "fabric" opts out of the 8ft remap', () => {
  assert.deepEqual(resolveDimensions('SKUVB', 'Fabric Banner', '8', '8'),
    { width: 8, height: 8, unit: 'ft' });
});

test('resolveDimensions: SKUXBB is inch-quoted on the Shopify path only', () => {
  // ShopifyDetails INTSKU contains SKUXBB; the QTSOrderDetails copy does not.
  assert.equal(resolveDimensions('SKUXBB', 'X Banner Stand', '6', '5', SHOPIFY).unit, 'in');
  assert.equal(resolveDimensions('SKUXBB', 'X Banner Stand', '6', '5', QTS).unit, 'ft');
});

// --- finishing labels ------------------------------------------------------

test('getFinishMode: live-store label spellings resolve on the Shopify path', () => {
  assert.deepEqual(getFinishMode('Hem & Grommets').grommets.sides,
    ['top', 'left', 'right', 'bottom']);
  assert.equal(getFinishMode('Pole Pockets (Top Only)').specialFinishing, 'PPTO');
  assert.equal(getFinishMode('Pole Pockets (Top and Bottom)').specialFinishing, 'PPTB');
  assert.equal(getFinishMode('Hem Only').descSuf, 'HO');
  assert.equal(getFinishMode('No Hem / Grommets Only').descSuf, 'GO');
  assert.deepEqual(getFinishMode('Something New'), {});
});

test('getFinishMode: QTS normalisation keeps "&" and "(" so those labels miss', () => {
  // QTSOrderDetails strips whitespace only — this is why the QTS path finishes
  // nothing for the live store's label format.
  assert.deepEqual(getFinishMode('Hem & Grommets', { variant: QTS }), {});
  assert.deepEqual(getFinishMode('Pole Pockets (Top Only)', { variant: QTS }), {});
});

test('getFinishMode: "Grommet with Bravo Tab" exists on the Shopify path only', () => {
  assert.ok(getFinishMode('Grommet with Bravo Tab').grommets);
  assert.deepEqual(getFinishMode('Grommet with Bravo Tab', { variant: QTS }), {});
});

test('getFinishMode: product name "pop up retractable" forces RET before the label', () => {
  const opts = { productName: 'Pop Up Retractable Banner' };
  assert.deepEqual(getFinishMode('Pole Pockets (Top and Bottom)', opts),
    { specialFinishing: 'RET' });
  // QTSOrderDetails has no product-name rule, so the label still wins there.
  // Uses the "PPTB" spelling because QTS normalisation cannot match the
  // parenthesised one (asserted separately above).
  assert.equal(getFinishMode('PPTB', { ...opts, variant: QTS }).specialFinishing, 'PPTB');
});

test('getFinishMode: the 14.5oz material trigger is Shopify-disabled, QTS-live', () => {
  assert.deepEqual(getFinishMode('14.5oz. PET Ultra-Smooth PVC'), {});
  assert.deepEqual(getFinishMode('14.5oz. PET Ultra-Smooth PVC', { variant: QTS }),
    { specialFinishing: 'RET' });
});

test('getFinishObj: a retractable ordered with grommets does not throw', () => {
  // Legacy throws TypeError here (RET has no `grommets` key but the label is in
  // GROMMETS_FINISHES). We skip the counts instead.
  const obj = getFinishObj('Hem & Grommets', 6, 5, 'ft', 1,
    { productName: 'Pop Up Retractable Banner' });
  assert.deepEqual(obj, { specialFinishing: 'RET', quantity: 1 });
});

// --- grommet counts (identical in both legacy classes) ---------------------

test('grommet counts follow the legacy size bands', () => {
  assert.deepEqual(getGrommetsCount2(3, 3, 'ft'), [2, 2]);
  assert.deepEqual(getGrommetsCount2(46, 46, 'in'), [3, 3]);
  assert.deepEqual(getGrommetsCount2(10, 5, 'ft'), [5, 3]);
  assert.equal(getSingleSideGrommetsCount(36), 2);
  assert.equal(getSingleSideGrommetsCount(72), 3);
  assert.equal(getSingleSideGrommetsCount(108), 4);
  assert.equal(getSingleSideGrommetsCount(155), 5);
  assert.equal(getSingleSideGrommetsCount(180), 6);
});

// --- artwork ---------------------------------------------------------------

test('artwork: Shopify reads the variation list and ignores metadata', () => {
  const it = firstItem(order({
    vl: { 'Uploaded File': undefined },
    metadata: { image1: 'https://cdn/x?file=/a/b.pdf' },
  }));
  assert.equal(it.artworkUrl, undefined);
  assert.equal(it.isMissingFile, true);
});

test('artwork: QTS reads metadata.image1..5', () => {
  const it = firstItem(order({
    sourceId: '4823801586',
    vl: { 'Uploaded File': undefined },
    metadata: { image1: 'https://cdn/x?file=/a/b.pdf' },
  }));
  assert.equal(it.isMissingFile, false);
  assert.equal(it.artworkExt, 'pdf');
});

test('artwork: an unsupported extension is a missing file, not a job', () => {
  // Legacy VALID_FILES_EXT has no eps — such a line is tagged Red for staff.
  const it = firstItem(order({ vl: { 'Uploaded File': 'https://cdn.shop/files/art.eps' } }));
  assert.equal(it.isMissingFile, true);
  assert.equal(it.artworkUrl, undefined);
});

test('artwork: several uploads set hasMultipleFiles and produce no artwork', () => {
  const it = firstItem(order({
    vl: { 'Uploaded File': undefined, 'Uploaded File 1': 'https://cdn.shop/files/a.pdf' },
  }));
  assert.equal(it.hasMultipleFiles, true);
  assert.equal(it.isMissingFile, false);
  assert.equal(it.artworkUrl, undefined);
});

test('artwork: an S3 key from our uploads bucket still parses', () => {
  const it = firstItem(order({ vl: { 'Uploaded File': 'TEST001/art.png' } }));
  assert.equal(it.isMissingFile, false);
  assert.equal(it.artworkUrl, 'TEST001/art.png');
});

// --- order-level flags (feed the intake gate) ------------------------------

test('flags: legacy rollups are computed per order', () => {
  assert.equal(cleanOrder(order({ name: 'Sticker Roll' })).flags.hasSpecialProduct, true);
  assert.equal(cleanOrder(order({ name: 'Fabric Pop Up Display' })).flags.hasSpecialProduct, true);
  assert.equal(cleanOrder(order({ name: 'See Thru Decal' })).flags.hasSeeThru, true);
  assert.equal(cleanOrder(order({ vl: { 'SPECIAL INSTRUCTIONS': 'match pantone 485' } }))
    .flags.hasInstructions, true);
  assert.equal(cleanOrder(order({ sourceId: '000123' })).flags.isDc, true);
  assert.equal(cleanOrder(order()).flags.hasSpecialProduct, false);
});

test('cleanOrder: alternate Shopify field spellings are accepted', () => {
  const o = order({ vl: { WIDTH: undefined, HEIGHT: undefined, 'FINISHING OPTIONS': undefined } });
  o.order_items[0].variation_list.Width = '6';
  o.order_items[0].variation_list.Height = '5';
  o.order_items[0].variation_list['Finishing Options'] = 'Hem & Grommets';
  const it = cleanOrder(o).items[0];
  assert.equal(it.width, 6);
  assert.equal(it.height, 5);
  assert.ok(it.finishingObj.grommets);
});

test('cleanOrder: quantity labels the file, it never duplicates the image', () => {
  const it = firstItem(order({ qty: 3 }));
  assert.equal(it.finishingObj.quantity, 3);
  assert.equal(it.artworkUrls.length, 1);
});
