// Intake gate tests — run with `npm run test:shared` (node --test).
//
// Pins the five checks legacy runs before an order may be auto-processed
// (SBBotExpress queueHelpers.getBatchJobData), their precedence, and the
// OrderDesk folder/tag each one maps to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOrder } from '../../src/shared/orderdesk.mjs';
import {
  intakeGate, GATES, ORDERDESK_FOLDERS, ORDERDESK_TAGS,
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
  assert.deepEqual(GATES.map((g) => g.reason), [
    'special-product', 'multiple-files', 'special-instructions', 'dc-order', 'missing-file',
  ]);
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
