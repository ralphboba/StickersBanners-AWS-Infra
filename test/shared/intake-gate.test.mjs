// Intake gate tests — run with `npm run test:shared` (node --test).
//
// Pins the five checks legacy runs before an order may be auto-processed
// (SBBotExpress queueHelpers.getBatchJobData), their precedence, and the
// OrderDesk folder/tag each one maps to — plus ours, which hold an implausibly
// large item and an order with nothing to print, and must never displace one of
// Linh's reasons.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOrder } from '../../src/shared/orderdesk.mjs';
import {
  intakeGate, oversizedItem, folderIds, GATES, MAX_SIDE_INCHES,
  ORDERDESK_FOLDERS, ORDERDESK_TAGS,
} from '../../src/shared/intake-gate.mjs';
import { orderDeskWritesEnabled } from '../../src/shared/orderdesk-write.mjs';

const ART = 'https://cdn.shop/files/art.pdf';

// `art: null` means the line has no uploaded file. (A default in a
// destructuring pattern also fires for an explicit `undefined`, so null is the
// only way to say "absent" here.)
function job({ name = 'Custom Vinyl Banner', sku = 'SKUVB', sourceId = 'S56001',
               vl = {}, art = ART } = {}) {
  return cleanOrder({
    source_id: sourceId,
    id: '900',
    order_metadata: { 'First Rep': 'Shopify' },
    shipping: { state: 'GA', postal_code: '30001' },
    order_items: [{
      code: sku, name, quantity: 1, id: 'LI1',
      variation_list: {
        WIDTH: '6', HEIGHT: '5', 'FINISHING OPTIONS': 'Hem & Grommets',
        ...(art === null ? {} : { 'Uploaded File': art }),
        ...vl,
      },
      metadata: {},
    }],
  });
}

test('a clean order clears every gate and is allowed through', () => {
  assert.equal(intakeGate(job()), null);
});

test('special products go to sales (legacy Blue)', () => {
  for (const name of ['Sticker Roll', 'Fabric Pop Up Display', '10ft POP UP DISPLAY']) {
    const g = intakeGate(job({ name }));
    assert.equal(g.reason, 'special-product', name);
    assert.equal(g.folder, 'sales');
    assert.equal(g.tag, 'Blue');
    assert.equal(g.folderId, '657836');
  }
});

test('several uploaded files go to sales (legacy Yellow)', () => {
  const g = intakeGate(job({ art: null, vl: { 'Uploaded File 1': ART } }));
  assert.equal(g.reason, 'multiple-files');
  assert.equal(g.folder, 'sales');
  assert.equal(g.tag, 'Yellow');
});

test('special instructions go to manual (legacy Purple)', () => {
  const g = intakeGate(job({ vl: { 'SPECIAL INSTRUCTIONS': 'match pantone 485' } }));
  assert.equal(g.reason, 'special-instructions');
  assert.equal(g.folder, 'manual');
  assert.equal(g.tag, 'Purple');
  assert.equal(g.folderId, '652268');
});

test('an empty instructions field does not trip the gate', () => {
  assert.equal(intakeGate(job({ vl: { 'SPECIAL INSTRUCTIONS': '' } })), null);
});

test('distribution-centre orders go to manual (legacy Orange)', () => {
  const g = intakeGate(job({ sourceId: '000123' }));
  assert.equal(g.reason, 'dc-order');
  assert.equal(g.tag, 'Orange');
});

test('missing or unusable artwork goes to manual (legacy Red)', () => {
  assert.equal(intakeGate(job({ art: null })).reason, 'missing-file');
  // eps is not in legacy VALID_FILES_EXT
  assert.equal(intakeGate(job({ art: 'https://cdn.shop/files/art.eps' })).reason, 'missing-file');
  const g = intakeGate(job({ art: null }));
  assert.equal(g.folder, 'manual');
  assert.equal(g.tag, 'Red');
});

test('precedence follows legacy: the earliest failing check wins', () => {
  // A sticker with special instructions AND no artwork: legacy returns at
  // hasSpecialProduct, before it ever looks at the other two.
  const g = intakeGate(job({
    name: 'Sticker Roll', art: null, vl: { 'SPECIAL INSTRUCTIONS': 'rush' },
  }));
  assert.equal(g.reason, 'special-product');

  // Instructions are checked before the missing file.
  const g2 = intakeGate(job({ art: null, vl: { 'SPECIAL INSTRUCTIONS': 'rush' } }));
  assert.equal(g2.reason, 'special-instructions');
});

test('gate order and folder/tag tables match legacy', () => {
  // Linh's five, in his order, with nothing inserted between them. Ours may
  // only ever be appended after — an order that trips one of his must keep
  // reporting his reason and landing where his bot would have sent it.
  assert.deepEqual(GATES.slice(0, 5).map((g) => g.reason), [
    'special-product', 'multiple-files', 'special-instructions', 'dc-order', 'missing-file',
  ]);
  assert.deepEqual(GATES.slice(5).map((g) => g.reason),
    ['b2sign', 'oversize', 'nothing-to-print', 'no-size'],
    'ours go after his; b2sign leads them because it is a production route, not a fault');
  assert.equal(ORDERDESK_FOLDERS.sales, '657836');
  assert.equal(ORDERDESK_FOLDERS.manual, '652268');
  assert.equal(ORDERDESK_FOLDERS.review, '653109');
  assert.equal(ORDERDESK_TAGS.Red, 'error');
  assert.equal(ORDERDESK_TAGS.Purple, 'purple');
});

// --- the safety switch -----------------------------------------------------

test('OrderDesk writes are off unless explicitly armed', () => {
  const saved = process.env.ORDERDESK_WRITES;
  try {
    delete process.env.ORDERDESK_WRITES;
    assert.equal(orderDeskWritesEnabled(), false, 'unset must be off');
    for (const v of ['', '0', 'false', 'no', 'true', '1', 'yes', 'ENABLE']) {
      process.env.ORDERDESK_WRITES = v;
      assert.equal(orderDeskWritesEnabled(), false, `"${v}" must not arm writes`);
    }
    process.env.ORDERDESK_WRITES = 'enabled';
    assert.equal(orderDeskWritesEnabled(), true);
    process.env.ORDERDESK_WRITES = ' ENABLED ';
    assert.equal(orderDeskWritesEnabled(), true, 'case and padding tolerated');
  } finally {
    if (saved === undefined) delete process.env.ORDERDESK_WRITES;
    else process.env.ORDERDESK_WRITES = saved;
  }
});

// --- the oversize hold (ours, not legacy's) --------------------------------

test('an implausibly large item is held for a person', () => {
  // SKU-607 recorded as "115x91 ft". It is 115x91 INCHES — the same twelve-fold
  // misread behind every dimension bug found so far.
  const g = intakeGate({ flags: {}, items: [{ sku: 'SKU-607', width: 115, height: 91, unit: 'ft' }] });
  assert.equal(g.reason, 'oversize');
  assert.equal(g.folder, 'manual');
  assert.equal(g.tag, 'Red');
});

test('the same product in inches passes untouched', () => {
  assert.equal(
    intakeGate({ flags: {}, items: [{ sku: 'SKU-607', width: 115, height: 91, unit: 'in' }] }),
    null);
});

test('the largest real banner seen still passes', () => {
  // 19x5 ft (228 in) was the biggest legitimate side across 397 real line
  // items. The threshold has to clear it with room, or the hold becomes noise.
  assert.equal(intakeGate({ flags: {}, items: [{ width: 19, height: 5, unit: 'ft' }] }), null);
  assert.equal(intakeGate({ flags: {}, items: [{ width: 216, height: 92, unit: 'in' }] }), null);
});

test('the unresolved parse cases are caught too', () => {
  // SKUAB arrives as '48 in' x '80 in' and the unit inside the value is lost.
  assert.equal(
    intakeGate({ flags: {}, items: [{ sku: 'SKUAB', width: 48, height: 80, unit: 'ft' }] }).reason,
    'oversize');
  // SKUVB is genuinely sold in feet, so only magnitude can catch 144x18.
  assert.equal(
    intakeGate({ flags: {}, items: [{ sku: 'SKUVB', width: 144, height: 18, unit: 'ft' }] }).reason,
    'oversize');
});

test('a legacy reason still wins over ours', () => {
  const g = intakeGate({
    flags: { isMissingFile: true },
    items: [{ width: 115, height: 91, unit: 'ft' }],
  });
  assert.equal(g.reason, 'missing-file', 'Linh’s checks are reported first');
});

test('one oversized item holds the whole order', () => {
  const g = intakeGate({
    flags: {},
    items: [{ width: 2, height: 3, unit: 'ft' }, { width: 115, height: 91, unit: 'ft' }],
  });
  assert.equal(g.reason, 'oversize');
});

test('an unparsable size is not treated as oversize', () => {
  // This check is about MAGNITUDE only and must never quietly become a validity
  // check — NaN is not a large number. An unparsable size is held now, but by
  // no-size; what is pinned here is which reason fires, and that oversizedItem
  // itself still reports nothing.
  for (const items of [[{ width: null, height: 'x', unit: 'ft' }], [{}]]) {
    assert.equal(intakeGate({ flags: {}, items }).reason, 'no-size');
    assert.equal(oversizedItem({ items }), null);
  }
  // No items at all is a different finding again.
  assert.equal(intakeGate({ flags: {} }).reason, 'nothing-to-print');
  assert.equal(oversizedItem({ flags: {} }), null);
});

test('oversizedItem reports which item and its inches', () => {
  const hit = oversizedItem({ items: [{ sku: 'A', width: 2, height: 2, unit: 'ft' },
                                      { sku: 'B', width: 115, height: 91, unit: 'ft' }] });
  assert.equal(hit.item.sku, 'B');
  assert.equal(hit.widthIn, 1380);
  assert.equal(hit.heightIn, 1092);
});

test('the threshold clears real orders but catches the misreads', () => {
  // p90 of 397 real items was 96 in and p99 was 216 in; the largest was 228.
  // The only sides above that in the whole sample were 1380 in — the misreads.
  assert.ok(MAX_SIDE_INCHES > 228, 'must clear the largest real banner');
  assert.ok(MAX_SIDE_INCHES < 1380, 'must catch inches read as feet');
});

// --- the trial-run folder redirection --------------------------------------

test('with nothing set, the real folders are used', () => {
  assert.deepEqual(folderIds({}), ORDERDESK_FOLDERS);
  assert.deepEqual(folderIds({ ORDERDESK_FOLDER_IDS: '  ' }), ORDERDESK_FOLDERS);
});

test('only the named keys move; the rest stay real', () => {
  const ids = folderIds({
    ORDERDESK_FOLDER_IDS: '{"processing":"111","manual":"222","sales":"333"}',
  });
  assert.equal(ids.processing, '111');
  assert.equal(ids.manual, '222');
  assert.equal(ids.sales, '333');
  assert.equal(ids.proofing, ORDERDESK_FOLDERS.proofing, 'untouched keys keep the real id');
  assert.equal(ids.GA, ORDERDESK_FOLDERS.GA);
});

test('the real table is never mutated by a redirection', () => {
  const before = { ...ORDERDESK_FOLDERS };
  folderIds({ ORDERDESK_FOLDER_IDS: '{"manual":"999"}' });
  assert.deepEqual(ORDERDESK_FOLDERS, before,
    'ending the trial must be able to rely on this table');
});

test('a broken value falls back to the real folders instead of throwing', () => {
  // A typo here at 4am must not take the poller down, and it must not invent a
  // folder id either — the safe fallback is the behaviour we already have.
  for (const raw of ['{', 'null', '[]', '"x"', '{"manual":}']) {
    assert.deepEqual(folderIds({ ORDERDESK_FOLDER_IDS: raw }), ORDERDESK_FOLDERS, raw);
  }
});

test('unknown keys and non-numeric ids are dropped, not trusted', () => {
  const ids = folderIds({
    ORDERDESK_FOLDER_IDS: '{"nosuchfolder":"111","manual":"Kai-TEST-manual","sales":"444"}',
  });
  assert.equal(ids.nosuchfolder, undefined);
  assert.equal(ids.manual, ORDERDESK_FOLDERS.manual, 'a folder NAME is not an id');
  assert.equal(ids.sales, '444');
});

test('a numeric id given as a number still works', () => {
  assert.equal(folderIds({ ORDERDESK_FOLDER_IDS: '{"manual":222}' }).manual, '222');
});

// --- Linh's 50ft ceiling, 2026-09-18 ---------------------------------------
// "There's technically no maximum print size, but the biggest we delegated for
// the bot to proof is 50ft. The bigger ones are handled via email manually."

test('50ft is the bot ceiling and passes; past it goes to a person', () => {
  assert.equal(MAX_SIDE_INCHES, 600, '50 ft = 600 in');
  assert.equal(intakeGate({ flags: {}, items: [{ width: 50, height: 4, unit: 'ft' }] }), null);
  assert.equal(intakeGate({ flags: {}, items: [{ width: 600, height: 48, unit: 'in' }] }), null);
  assert.equal(
    intakeGate({ flags: {}, items: [{ width: 51, height: 4, unit: 'ft' }] }).reason,
    'oversize');
});

test('a 40ft banner passes, which the old 300in threshold would have held', () => {
  // The threshold used to be 300 in, picked from our own data rather than from
  // Linh. Anything between 25 and 50 feet was being held for no reason.
  assert.equal(intakeGate({ flags: {}, items: [{ width: 40, height: 8, unit: 'ft' }] }), null);
});

// --- nothing to print (ours, not legacy's) ---------------------------------
//
// S61855 on 2026-09-19: an 8'x8' telescopic stand and no banner. Every flag
// false, so it cleared the gate, produced no files in resize or finish, and
// died in the transfer step on "No finished files found" after four attempts.

/** An order whose only line is hardware, so cleanOrder leaves items empty. */
function hardwareOnlyJob() {
  return cleanOrder({
    source_id: 'S61855',
    id: '4978542564',
    order_metadata: { 'First Rep': 'Shopify' },
    shipping: { state: 'GA', postal_code: '30078' },
    order_items: [{
      code: 'SKUBS08X08',
      name: "8'x8' Telescopic Adjustable Stand",
      quantity: 1,
      id: 'LI1',
      variation_list: {},
      metadata: {},
    }],
  });
}

test('an order with no printable item is held, not processed', () => {
  const j = hardwareOnlyJob();
  assert.equal(j.items.length, 0, 'the hardware line is dropped, as in legacy');
  assert.ok(j.hardwareItems?.length, 'and kept aside so the record is complete');

  const g = intakeGate(j);
  assert.ok(g, 'S61855 must not clear the gate');
  assert.equal(g.reason, 'nothing-to-print');
  assert.equal(g.folder, 'manual');
  assert.equal(g.tag, 'Red');
  assert.equal(g.folderId, ORDERDESK_FOLDERS.manual);
});

test('a missing items array is held rather than crashing the gate', () => {
  assert.equal(intakeGate({ flags: {} }).reason, 'nothing-to-print');
  assert.equal(intakeGate({ flags: {}, items: [] }).reason, 'nothing-to-print');
});

test('one printable item is enough to clear the nothing-to-print check', () => {
  assert.equal(intakeGate(job()), null);
});

test("nothing-to-print never displaces one of Linh's reasons", () => {
  // An order with no printable items AND special instructions must still report
  // the instructions, because that is where legacy would have filed it.
  const j = hardwareOnlyJob();
  j.flags.hasInstructions = true;
  assert.equal(intakeGate(j).reason, 'special-instructions');
});

// --- no usable size (ours, not legacy's) -----------------------------------
//
// From the 2026-09-22 census: three yard-sign / feather-flag items cleared
// every other check with width: undefined, because those products record no
// size anywhere in the order. resize would have called float(None) on them.

test('an item with no size is held', () => {
  // Deliberately NOT a yard sign: those are B2Sign work and report that
  // instead, which is a different finding with a different owner.
  const g = intakeGate({ flags: {}, items: [{ sku: 'SKUVB', name: 'Custom Vinyl Banners', width: undefined, height: undefined }] });
  assert.equal(g.reason, 'no-size');
  assert.equal(g.folder, 'manual');
  assert.equal(g.tag, 'Red');
});

test('every unusable size shape is caught, not just undefined', () => {
  for (const bad of [
    { width: undefined, height: 3 },
    { width: 5, height: undefined },
    { width: NaN, height: 3 },
    { width: 0, height: 3 },
    { width: -2, height: 3 },
    { width: 5, height: 0 },
    { width: null, height: null },
    { width: 'x', height: 'y' },
  ]) {
    assert.equal(intakeGate({ flags: {}, items: [bad] })?.reason, 'no-size',
      `${JSON.stringify(bad)} must not reach the workers`);
  }
});

test('one bad item holds the whole order', () => {
  const g = intakeGate({ flags: {}, items: [{ width: 4, height: 6 }, { width: undefined, height: 3 }] });
  assert.equal(g.reason, 'no-size');
});

test('ordinary sizes are untouched', () => {
  assert.equal(intakeGate({ flags: {}, items: [{ width: 4, height: 6 }] }), null);
  assert.equal(intakeGate({ flags: {}, items: [{ width: 0.5, height: 0.25 }] }), null,
    'a small but real size is a size');
  assert.equal(intakeGate({ flags: {}, items: [{ width: '5', height: '3' }] }), null,
    'numeric strings are what the parser actually produces');
});

test("no-size never displaces one of Linh's reasons", () => {
  const j = { flags: { hasInstructions: true }, items: [{ width: undefined, height: undefined }] };
  assert.equal(intakeGate(j).reason, 'special-instructions');
});

test('oversize is reported before no-size when both could apply', () => {
  // Ours are ordered too: an implausibly large item is a more specific finding
  // than a missing one, and only one reason can be reported.
  const j = { flags: {}, items: [{ width: 115, height: 91, unit: 'ft' }, { width: undefined, height: 1 }] };
  assert.equal(intakeGate(j).reason, 'oversize');
});

// --- B2Sign products (ours, and first of ours) ------------------------------
//
// Kai, 2026-09-24: yard signs, flag banners, event tents and canvas wraps are
// orders we take and hand to B2Sign. Danny does it by hand. No print file of
// ours should exist for one, and none should reach a facility.

test('a yard sign reports b2sign, not the symptom it used to report', () => {
  const g = intakeGate({ flags: {}, items: [{ sku: 'YSHDS', name: 'Yard Sign' }] });
  assert.equal(g.reason, 'b2sign');
  assert.equal(g.folder, 'manual');
});

test('every B2Sign family is caught', () => {
  for (const item of [
    { sku: 'YSSOSS', name: 'Yard Sign' },
    { sku: 'ET10', name: '10ft Event Tent' },
    { sku: 'TFW15', name: '15ft Tent Full Walls' },
    { sku: 'ADDON-SAND-4', name: 'Event Tent Options' },
    { sku: 'T15-FWL-1', name: '15ft Event Tent Options' },
    { sku: 'YS-HSTAKE', name: 'Yard Sign Options' },
    { sku: '', name: 'Feather Angled Flag (Large)' },   // flags carry no SKU
    { sku: null, name: 'Econo Feather Flag' },
    { sku: '', name: 'Canvas Wrap 16x20' },             // none in the store yet
  ]) {
    assert.equal(intakeGate({ flags: {}, items: [item] })?.reason, 'b2sign',
      `${item.sku ?? '(no sku)'} / ${item.name}`);
  }
});

test('our own printed products are NOT diverted to B2Sign', () => {
  // The expensive mistake would be the other direction: holding the 452
  // vinyl banners a day. Fabric Step and Repeat is the trap — its material
  // reads like canvas, and it is one of the highest-volume products we print.
  for (const item of [
    { sku: 'SKUVB', name: 'Custom Vinyl Banners', width: 6, height: 5 },
    { sku: 'SKUFSR08X08', name: 'Fabric Step and Repeat Banner', width: 8, height: 8 },
    { sku: 'SKUCFSR', name: 'Custom Fabric Step and Repeat Banner', width: 4, height: 4 },
    { sku: 'SKUMB', name: 'Mesh Banners', width: 5, height: 3 },
    { sku: 'SKUAB', name: 'Adhesive Banners', width: 4, height: 6 },
    { sku: 'SKUCSR', name: 'Custom Step and Repeat', width: 8, height: 8 },
  ]) {
    assert.equal(intakeGate({ flags: {}, items: [item] }), null,
      `${item.sku} must still be processed by us`);
  }
});

test("b2sign is reported before our own fault checks", () => {
  // A yard sign has no size; it must say b2sign, which is the actionable fact.
  const g = intakeGate({ flags: {}, items: [{ sku: 'YSHSS', name: 'Yard Sign' }] });
  assert.equal(g.reason, 'b2sign');
  assert.deepEqual(GATES.slice(5).map((x) => x.reason),
    ['b2sign', 'oversize', 'nothing-to-print', 'no-size']);
});

test("b2sign still never displaces one of Linh's reasons", () => {
  const g = intakeGate({ flags: { hasInstructions: true }, items: [{ sku: 'ET10', name: '10ft Event Tent' }] });
  assert.equal(g.reason, 'special-instructions',
    'parity with Linh comes first; the census counts B2Sign separately for this reason');
});
