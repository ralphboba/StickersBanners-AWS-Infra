// Special instructions handled on the dashboard (Kai, 2026-10-11): a person
// fixes what the customer asked for and the order re-runs from the top.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyRelease, uploadKey, uploadPrefix, uploadedName } from '../../src/functions/order-api/instructions.mjs';
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
  test('the items are untouched and the job runs as an ordinary order', () => {
    const r = applyRelease(META, { mode: 'as-is' }, ctx);
    assert.deepEqual(r.items, META.items);
    assert.equal(r.job.staffRelease, true);
    assert.equal(r.job.manualFiles, undefined);
    assert.equal(r.job.instructionsRelease.mode, 'as-is');
    assert.equal(r.job.testLane, true);
    for (const k of ['PK', 'SK', 'GSI1PK', 'status', 'hold']) assert.equal(k in r.job, false, k);
  });
});

describe('final files attached by the office', () => {
  const k1 = `${uploadPrefix('S67674')}1/111-final_1.pdf`;
  const k2 = `${uploadPrefix('S67674')}2/222-final_2.psd`;

  test('every item takes its file; the job is marked manual', () => {
    const r = applyRelease(META, { mode: 'final', items: [{ itemNo: 1, uploadKey: k1 }, { itemNo: '2', uploadKey: k2 }] }, ctx);
    assert.equal(r.job.manualFiles, true);
    assert.equal(r.items[0].artworkUrl, `s3://sb-dev-uploads-1/${k1}`);
    assert.equal(r.items[0].artworkExt, 'pdf');
    assert.equal(r.items[0].finalFileName, 'final_1.pdf');
    assert.equal(r.items[0].customerArtworkUrl, META.items[0].artworkUrl);
    assert.equal(r.items[1].artworkExt, 'psd');
    // size and finishing stay as ordered -- nothing is resized or marked
    assert.equal(r.items[1].width, 3);
    assert.deepEqual(r.items[1].finishingObj, META.items[1].finishingObj);
    assert.deepEqual(r.release.items, [{ itemNo: 1, file: 'final_1.pdf' }, { itemNo: 2, file: 'final_2.psd' }]);
  });

  test('refuses a missing, foreign or unprintable file', () => {
    const go = (items) => applyRelease(META, { mode: 'final', items }, ctx);
    assert.match(go([{ itemNo: 1, uploadKey: k1 }]).error, /item 2/);
    assert.equal(go([{ itemNo: 1, uploadKey: 'staff/S99999/1/1-x.pdf' }, { itemNo: 2, uploadKey: k2 }]).code, 400);
    assert.equal(go([{ itemNo: 1, uploadKey: k2 }, { itemNo: 2, uploadKey: k2 }]).code, 400);
    assert.equal(go([{ itemNo: 1, uploadKey: `${uploadPrefix('S67674')}1/1-x.docx` }, { itemNo: 2, uploadKey: k2 }]).code, 400);
  });
});

describe('upload keys', () => {
  test('a printable file under the order and item', () => {
    const k = uploadKey('S67674', 2, 'My Banner (final).psd', 5);
    assert.equal(k.key, 'staff/S67674/2/5-My_Banner__final_.psd');
    assert.equal(k.ext, 'psd');
    assert.match(uploadKey('S67674', 2, 'notes.docx').error, /cannot be printed/);
    assert.match(uploadKey('S67674', 'x', 'a.pdf').error, /itemNo/);
    assert.equal(uploadKey('../S1', 1, '../../a.pdf').key.startsWith('staff/S1/1/'), true);
    assert.equal(uploadedName(k.key), 'My_Banner__final_.psd');
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
