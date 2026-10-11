// Special instructions handled on the dashboard (Kai, 2026-10-11): a person
// fixes what the customer asked for and the order re-runs from the top.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyRelease, uploadKey, uploadPrefix, FINISH_CHOICES, GROMMET_SIDES } from '../../src/functions/order-api/instructions.mjs';
import { planMove } from '../../src/functions/orderdesk-move/core.mjs';
import { ORDERDESK_FOLDERS } from '../../src/shared/intake-gate.mjs';
import { cleanOrder } from '../../src/shared/orderdesk.mjs';

const META = {
  PK: 'ORDER#S67674', SK: 'META', GSI1PK: 'STATUS#needs_review', GSI1SK: '2026-10-09T17:37:24.000Z',
  orderName: 'S67674', status: 'needs_review', needsProof: true, testLane: true,
  source: { orderDeskId: '4981' }, routing: { facility: 'TX' },
  hold: { reason: 'special-instructions', explain: 'x' },
  items: [
    { itemNo: 1, name: 'Custom Vinyl Banners', quantity: 1, width: 5, height: 8, unit: 'ft',
      finishingRaw: 'Pole Pockets (Top Only)', finishingObj: { specialFinishing: 'PPTO', descSuf: 'PPTO', quantity: 1 },
      artworkUrl: 'https://x.s3.amazonaws.com/a.pdf', artworkExt: 'pdf', instructions: 'Grommets in 4 corners only' },
    { itemNo: 2, name: 'Custom Vinyl Banners', quantity: 1, width: 3, height: 4, unit: 'ft',
      finishingRaw: 'Hem & Grommets', finishingObj: { grommets: { sides: ['top', 'left', 'right', 'bottom'], widthGrommets: 3, heightGrommets: 3 }, quantity: 1 },
      artworkUrl: 'https://x.s3.amazonaws.com/b.png', artworkExt: 'png' },
  ],
};
const ctx = { by: 'kai', now: '2026-10-11T00:00:00Z', uploadsBucket: 'sb-dev-uploads-1' };

describe('who can be released', () => {
  test('only an order held for special instructions', () => {
    assert.equal(applyRelease({ ...META, hold: { reason: 'size-swapped' } }, { mode: 'as-is' }, ctx).code, 409);
    assert.equal(applyRelease({ ...META, status: 'proofing' }, { mode: 'as-is' }, ctx).code, 409);
    assert.equal(applyRelease({ ...META, mirror: true }, { mode: 'as-is' }, ctx).code, 403);
    assert.equal(applyRelease(undefined, { mode: 'as-is' }, ctx).code, 404);
    assert.equal(applyRelease(META, { mode: 'whatever' }, ctx).code, 400);
  });
});

describe('as is', () => {
  test('the items are untouched and the job carries the release', () => {
    const r = applyRelease(META, { mode: 'as-is' }, ctx);
    assert.deepEqual(r.items, META.items);
    assert.equal(r.job.staffRelease, true);
    assert.equal(r.job.instructionsRelease.mode, 'as-is');
    assert.equal(r.job.testLane, true);
    for (const k of ['PK', 'SK', 'GSI1PK', 'status', 'hold']) assert.equal(k in r.job, false, k);
  });
});

describe('with changes', () => {
  test('size, finishing and grommets are applied and recorded', () => {
    const r = applyRelease(META, { mode: 'changes', items: [
      { itemNo: 2, width: 4, height: 3, unit: 'ft', grommets: 'corners' },
    ] }, ctx);
    const it = r.items[1];
    assert.equal(it.width, 4); assert.equal(it.height, 3);
    assert.deepEqual(it.finishingObj.grommets.sides, []);
    assert.equal(it.orientationChecked, true);
    assert.deepEqual(r.items[0], META.items[0]);
    assert.deepEqual(r.release.items, [{ itemNo: 2, size: { from: '3x4 ft', to: '4x3 ft' }, grommets: 'corners' }]);
  });

  test('pole pocket on top, grommets along the bottom', () => {
    const r = applyRelease(META, { mode: 'changes', items: [{ itemNo: 1, grommets: 'bottom' }] }, ctx);
    const obj = r.items[0].finishingObj;
    assert.equal(obj.specialFinishing, 'PPTO');
    assert.deepEqual(obj.grommets.sides, ['bottom']);
    assert.ok(obj.grommets.widthGrommets >= 2);
  });

  test('a new finishing option is recomputed the way intake would', () => {
    const r = applyRelease(META, { mode: 'changes', items: [{ itemNo: 2, finishing: 'Pole Pockets (Top and Bottom)' }] }, ctx);
    assert.equal(r.items[1].finishingObj.specialFinishing, 'PPTB');
    assert.equal(r.items[1].finishingRaw, 'Pole Pockets (Top and Bottom)');
    assert.equal(applyRelease(META, { mode: 'changes', items: [{ itemNo: 2, finishing: 'Glitter' }] }, ctx).code, 400);
  });

  test('an uploaded file replaces the customer file for that item only', () => {
    const key = `${uploadPrefix('S67674')}1/123-edited.psd`;
    const r = applyRelease(META, { mode: 'changes', items: [{ itemNo: 1, uploadKey: key }] }, ctx);
    assert.equal(r.items[0].artworkUrl, `s3://sb-dev-uploads-1/${key}`);
    assert.equal(r.items[0].artworkExt, 'psd');
    assert.equal(r.items[0].customerArtworkUrl, META.items[0].artworkUrl);
    assert.equal(r.items[1].artworkUrl, META.items[1].artworkUrl);
    assert.equal(r.release.items[0].file, 'edited.psd');
  });

  test('refuses bad input', () => {
    const bad = (e) => applyRelease(META, { mode: 'changes', items: [e] }, ctx).code;
    assert.equal(bad({ itemNo: 2, width: 0, height: 3 }), 400);
    assert.equal(bad({ itemNo: 2, width: 60, height: 3, unit: 'ft' }), 400); // 720 in
    assert.equal(bad({ itemNo: 2, unit: 'cm' }), 400);
    assert.equal(bad({ itemNo: 9, width: 1, height: 1 }), 400);
    assert.equal(bad({ itemNo: 1, uploadKey: 'staff/S99999/1/1-x.pdf' }), 400); // another order's file
    assert.equal(bad({ itemNo: 1, uploadKey: `${uploadPrefix('S67674')}2/1-x.pdf` }), 400); // another item's file
    assert.equal(bad({ itemNo: 2, grommets: 'diagonal' }), 400);
    assert.equal(applyRelease(META, { mode: 'changes', items: [{ itemNo: 2, width: 3, height: 4, unit: 'ft' }] }, ctx).code, 400); // no change
  });
});

describe('upload keys', () => {
  test('a printable file under the order and item', () => {
    const k = uploadKey('S67674', 2, 'My Banner (final).psd', 5);
    assert.equal(k.key, 'staff/S67674/2/5-My Banner _final_.psd');
    assert.equal(k.ext, 'psd');
    assert.match(uploadKey('S67674', 2, 'notes.docx').error, /cannot be printed/);
    assert.match(uploadKey('S67674', 'x', 'a.pdf').error, /itemNo/);
    assert.equal(uploadKey('../S1', 1, '../../a.pdf').key.startsWith('staff/S1/1/'), true);
  });

  test('every finishing choice maps to a real finish', () => {
    for (const f of FINISH_CHOICES) {
      const r = applyRelease(META, { mode: 'changes', items: [{ itemNo: 2, finishing: f, width: 3, height: 5, unit: 'ft' }] }, ctx);
      assert.ok(!r.error, f);
    }
    assert.deepEqual(GROMMET_SIDES.corners, []);
  });
});

describe('OrderDesk moves after a release', () => {
  const F = ORDERDESK_FOLDERS;
  test('a released order may leave Manual; an ordinary one may not', () => {
    const job = { needsProof: true, source: { orderDeskId: '1' }, routing: { facility: 'GA' } };
    assert.deepEqual(planMove(job, 'proofing', F).expectFrom, [F.processing]);
    assert.deepEqual(planMove({ ...job, staffRelease: true }, 'proofing', F).expectFrom, [F.processing, F.manual, F.sales]);
    const noProof = { ...job, needsProof: false, staffRelease: true };
    assert.deepEqual(planMove(noProof, 'facility', F).expectFrom, [F.processing, F.manual, F.sales]);
  });
});

describe('intake keeps the text', () => {
  test('the instructions reach the job item', () => {
    const job = cleanOrder({ source_id: 'S1', order_items: [{ id: 1, name: 'Custom Vinyl Banners', code: 'SKUVB', quantity: 1,
      variation_list: { WIDTH: '3', HEIGHT: '2', 'FINISHING OPTIONS': 'Hem & Grommets', 'SPECIAL INSTRUCTIONS': '  Grommets top only  ',
        'UPLOADED FILE': 'https://x/a.png' } }] });
    assert.equal(job.items[0].instructions, 'Grommets top only');
    assert.equal(job.flags.hasInstructions, true);
  });
});
