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

test('resolveDimensions: SKU-608 is inches, not feet', () => {
  // Live order S59121. The product name contains "fabric", which opts out of
  // the remap, so the unit comes purely from the inch-SKU lists — and this SKU
  // was in none of them, resolving 145x91 to FEET (a 44-metre banner). The
  // resizer scales artwork to whatever number it is handed, so the wrong unit
  // means a print file 12x oversized, not a cosmetic label.
  const name = "10'x8' Fabric Pop Up Display Backdrop (Banner Only)";
  assert.deepEqual(resolveDimensions('SKU-608', name, '145', '91', SHOPIFY),
    { width: 145, height: 91, unit: 'in' });
  // Not a Shopify-only entry: the same product ordered through QTS is inches too.
  assert.equal(resolveDimensions('SKU-608', name, '145', '91', QTS).unit, 'in');
});

test('resolveDimensions: the rest of the pop-up display family is inches too', () => {
  // Found by the 2026-09-10 full-day census (350 real orders), which listed
  // every line still resolving to an implausible number of feet. Kai confirmed
  // all three by product name.
  //
  // SKU-604 is the SAME print as SKU-608 -- the backdrop sold with its stand --
  // so it carries the identical 145x91 and must resolve identically.
  const withStand = 'Fabric Pop Up Display Backdrop with Stand';
  assert.deepEqual(resolveDimensions('SKU-604', withStand, '145', '91', SHOPIFY),
    { width: 145, height: 91, unit: 'in' });
  assert.equal(resolveDimensions('SKU-604', withStand, '145', '91', QTS).unit, 'in');

  // The 8'x8' banner-only backdrop: 115x91in is its print size, the same way
  // 145x91in is the 10'x8's.
  const eightByEight = "8'x8' Fabric Pop Up Display Backdrop (Banner Only)";
  assert.deepEqual(resolveDimensions('SKU-607', eightByEight, '115', '91', SHOPIFY),
    { width: 115, height: 91, unit: 'in' });
  assert.equal(resolveDimensions('SKU-607', eightByEight, '115', '91', QTS).unit, 'in');

  // X-Banner: 30x69 is a standard panel. Note the name carries no "fabric" opt
  // out and 30/69 miss the remap table, so again the unit rests on this list.
  assert.deepEqual(resolveDimensions('SKUXBS', 'X-Banner', '30', '69', SHOPIFY),
    { width: 30, height: 69, unit: 'in' });
  assert.equal(resolveDimensions('SKUXBS', 'X-Banner', '30', '69', QTS).unit, 'in');
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

// --- proof gate (legacy getProofOption) ------------------------------------

test('proof: Shopify orders read checkout_data.Note, opt-out style', () => {
  const withNote = (Note) => cleanOrder({ ...order(), checkout_data: { Note } }).needsProof;
  assert.equal(withNote('please match the sample'), true, 'any text wants a proof');
  assert.equal(withNote('NO PROOF needed'), false);
  assert.equal(withNote(''), false, 'empty note = no proof');
  assert.equal(cleanOrder(order()).needsProof, false, 'absent checkout_data = no proof');
});

test('proof: QTS orders read checkout_data["Proof Option"] instead', () => {
  const o = { ...order({ sourceId: '4823801586' }), checkout_data: { 'Proof Option': 'yes' } };
  assert.equal(cleanOrder(o).needsProof, true);
  // The Shopify field is not consulted on the QTS path.
  const o2 = { ...order({ sourceId: '4823801586' }), checkout_data: { Note: 'yes' } };
  assert.equal(cleanOrder(o2).needsProof, false);
});

test('proof: a field whose value is "Yes" counts as wanting a proof', () => {
  // The previous substring-on-"proof" rule returned false here, so most orders
  // silently skipped Proofing and never got a Zendesk email.
  assert.equal(cleanOrder({ ...order(), checkout_data: { Note: 'Yes' } }).needsProof, true);
});

// --- hardware lines (legacy checkHardwareSku + items.filter) ----------------

test('hardware lines are dropped from the order', () => {
  const o = order();
  o.order_items.push({
    code: 'SKUBS08X08', name: "8' x 8' Adjustable Banner Stand", quantity: 1, id: 'LI2',
    variation_list: {}, metadata: {},
  });
  const job = cleanOrder(o);
  assert.equal(job.items.length, 1, 'only the printed line survives');
  assert.equal(job.items[0].sku, 'SKUVB');
  assert.deepEqual(job.hardwareItems.map((h) => h.sku), ['SKUBS08X08']);
});

test('a banner ordered with a stand still processes the banner', () => {
  // Before the hardware filter the stand had no artwork, so isMissingFile put
  // the WHOLE order in front of a person.
  const o = order();
  o.order_items.push({
    code: 'SKURC0408', name: "4' x 8' Red Carpet", quantity: 1, id: 'LI2',
    variation_list: {}, metadata: {},
  });
  const job = cleanOrder(o);
  assert.equal(job.flags.isMissingFile, false);
  assert.equal(job.items.length, 1);
});

test('itemNo is assigned before hardware is dropped, so files do not renumber', () => {
  // stand first, banner second -> the banner keeps itemNo 2 and its file stays "2-1"
  const o = order();
  o.order_items.unshift({
    code: 'SKUBS08X10', name: "10' x 8' Adjustable Banner Stand", quantity: 1, id: 'LI0',
    variation_list: {}, metadata: {},
  });
  const job = cleanOrder(o);
  assert.equal(job.items.length, 1);
  assert.equal(job.items[0].itemNo, 2);
  assert.deepEqual(Object.keys(job.renameDict), ['2-1']);
});

test('SKU-DXB-B is hardware as a stand but printed as a banner', () => {
  const dxb = (name) => cleanOrder({
    ...order(),
    order_items: [{
      code: 'SKU-DXB-B', name, quantity: 1, id: 'LI9',
      variation_list: { WIDTH: '6', HEIGHT: '5', 'FINISHING OPTIONS': 'Hem Only', 'Uploaded File': ART },
      metadata: {},
    }],
  });
  assert.equal(dxb('Double-Sided X-Banners(Stand only)').items.length, 0);
  assert.equal(dxb('Double-Sided X-Banners(banner only 1ea)').items.length, 1);
  assert.equal(dxb('Double-Sided X-Banners(banner only 2ea)').items.length, 1);
});

// --- renameDict (OrderDesk invoice thumbnails) -----------------------------

test('renameDict maps each proof jpg to the OrderDesk line-item id', () => {
  // Linh: the /proof upload feeds the invoice thumbnail, looked up by line id.
  const job = cleanOrder(order());
  assert.deepEqual(job.renameDict, { '1-1': 'LI1' });
});

test('a line with no id is left out of renameDict rather than renamed wrongly', () => {
  const o = order();
  delete o.order_items[0].id;
  assert.deepEqual(cleanOrder(o).renameDict, {});
});
