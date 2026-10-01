// Staff answer for a size-swapped hold (dashboard -> POST /orders/{name}/size).
import test from 'node:test';
import assert from 'node:assert/strict';

import { applySizeDecision } from '../../src/functions/order-api/size-decision.mjs';

const held = (over = {}) => ({
  PK: 'ORDER#S61383', SK: 'META', GSI1PK: 'STATUS#needs_review', GSI1SK: '2026-09-29',
  orderName: 'S61383', status: 'needs_review', stage: 'held', needsProof: true,
  routing: { facility: 'GA' },
  hold: {
    reason: 'size-swapped', source: 'resize',
    items: [{ itemNo: 2, ordered: '3 x 8 ft', swapped: '8 x 3 ft', hasPockets: false }],
  },
  items: [
    { itemNo: 1, width: 2, height: 4, unit: 'ft' },
    {
      itemNo: 2, width: 3, height: 8, unit: 'ft',
      finishingObj: { quantity: 1, grommets: { sides: ['top'], widthGrommets: 2, heightGrommets: 5 } },
    },
  ],
  ...over,
});

test('swap turns the flagged item round, grommet counts with it, and leaves the rest', () => {
  const out = applySizeDecision(held(), 'swap', { by: 'kai@x', now: 'T' });
  const [one, two] = out.items;
  assert.deepEqual([one.width, one.height, one.orientationChecked], [2, 4, undefined]);
  assert.deepEqual([two.width, two.height, two.orientationChecked], [8, 3, true]);
  assert.deepEqual(
    [two.finishingObj.grommets.widthGrommets, two.finishingObj.grommets.heightGrommets], [5, 2]);
  assert.deepEqual(out.decision, { choice: 'swap', by: 'kai@x', at: 'T', items: ['2'] });
});

test('keep prints as ordered but never asks again', () => {
  const two = applySizeDecision(held(), 'keep').items[1];
  assert.deepEqual([two.width, two.height, two.orientationChecked], [3, 8, true]);
});

test('the job put back on the queue is the job, not the row', () => {
  const { job } = applySizeDecision(held(), 'keep');
  for (const k of ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'status', 'stage', 'hold']) assert.equal(k in job, false, k);
  assert.equal(job.orderName, 'S61383');
  assert.equal(job.needsProof, true);
  assert.equal(job.items[1].orientationChecked, true);
});

test('refuses anything that is not a size-swapped hold', () => {
  assert.equal(applySizeDecision(undefined, 'swap').code, 404);
  assert.equal(applySizeDecision(held(), 'rotate').code, 400);
  assert.equal(applySizeDecision(held({ mirror: true }), 'swap').code, 403);
  assert.equal(applySizeDecision(held({ status: 'proofing' }), 'swap').code, 409);
  assert.equal(applySizeDecision(held({ hold: { reason: 'bad-artwork' } }), 'keep').code, 409);
});

test('pole pockets: no swap button, only keep (customer must confirm the layout)', () => {
  const h = held();
  h.hold.items[0].hasPockets = true;
  assert.equal(applySizeDecision(h, 'swap').code, 409);
  assert.ok(applySizeDecision(h, 'keep').items);
});
