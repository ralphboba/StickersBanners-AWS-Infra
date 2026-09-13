// Intake gate tests — run with `npm run test:shared` (node --test).
//
// Pins the five checks legacy runs before an order may be auto-processed
// (SBBotExpress queueHelpers.getBatchJobData), their precedence, and the
// OrderDesk folder/tag each one maps to — plus the sixth, ours, which holds an
// implausibly large item and must never displace one of Linh's reasons.

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
  assert.deepEqual(GATES.slice(5).map((g) => g.reason), ['oversize'],
    'ours go after his, and there is still only one of them');
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
  // NaN must fall through to the workers exactly as it does today; this check
  // is about magnitude only, and must not quietly become a validity check.
  assert.equal(intakeGate({ flags: {}, items: [{ width: null, height: 'x', unit: 'ft' }] }), null);
  assert.equal(intakeGate({ flags: {}, items: [{}] }), null);
  assert.equal(intakeGate({ flags: {} }), null);
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
