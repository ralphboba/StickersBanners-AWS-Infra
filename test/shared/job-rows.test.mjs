// Mirror row vs. real order row — run with `npm run test:shared`.
//
// The display-only mirror and the intake poller share PK=ORDER#<name>,SK=META.
// If a mirror row reads as "already processed", enabling the poller silently
// skips every real order; if the mirror can delete a row the pipeline claimed,
// a live order disappears. These pin both directions.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isMirrorRow, isClaimed, isConditionFailure,
  CLAIM_CONDITION, MIRROR_ONLY_CONDITION, MIRROR_VALUES,
} from '../../src/shared/job-rows.mjs';

const mirrorRow = { PK: 'ORDER#S56001', SK: 'META', mirror: true, status: 'in_queue' };
const orderRow = { PK: 'ORDER#S56001', SK: 'META', status: 'printing' };
const heldRow = { PK: 'ORDER#S56001', SK: 'META', status: 'needs_review', hold: { reason: 'dc-order' } };

test('a mirror row is not a claimed order', () => {
  assert.equal(isMirrorRow(mirrorRow), true);
  assert.equal(isClaimed(mirrorRow), false);
});

test('a real order row is claimed, held or not', () => {
  assert.equal(isMirrorRow(orderRow), false);
  assert.equal(isClaimed(orderRow), true);
  assert.equal(isClaimed(heldRow), true);
});

test('no row at all is not claimed', () => {
  for (const empty of [undefined, null]) {
    assert.equal(isClaimed(empty), false);
    assert.equal(isMirrorRow(empty), false);
  }
});

test('only the literal true flag counts as a mirror row', () => {
  // A row whose mirror attribute is absent or falsy belongs to the pipeline.
  for (const v of [false, 'true', 1, 0, null, undefined]) {
    assert.equal(isMirrorRow({ ...orderRow, mirror: v }), false, `mirror=${String(v)}`);
    assert.equal(isClaimed({ ...orderRow, mirror: v }), true, `mirror=${String(v)}`);
  }
});

test('the claim condition lets the poller take a mirror row but not an order row', () => {
  // Mirrors the DynamoDB semantics we rely on: create when absent, overwrite
  // when the existing row is the mirror's, refuse when it is a real order.
  assert.equal(CLAIM_CONDITION, 'attribute_not_exists(PK) OR mirror = :mirrorTrue');
  assert.deepEqual(MIRROR_VALUES, { ':mirrorTrue': true });
});

test('the mirror-only condition guards its prune', () => {
  assert.equal(MIRROR_ONLY_CONDITION, 'mirror = :mirrorTrue');
});

test('isConditionFailure recognises only the DynamoDB condition error', () => {
  assert.equal(isConditionFailure({ name: 'ConditionalCheckFailedException' }), true);
  assert.equal(isConditionFailure({ name: 'ResourceNotFoundException' }), false);
  assert.equal(isConditionFailure(new Error('boom')), false);
  assert.equal(isConditionFailure(undefined), false);
});
