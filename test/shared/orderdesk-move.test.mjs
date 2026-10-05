// The OrderDesk moves after intake: Processing -> Proofing -> Pending Review ->
// facility (Linh, 2026-10-05). These move REAL orders once ORDERDESK_WRITES is
// armed, so most of this is about when they must not.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { planMove, checkFrom } from '../../src/functions/orderdesk-move/core.mjs';
import { updateOrderDeskDetails } from '../../src/shared/orderdesk-write.mjs';
import { ORDERDESK_FOLDERS } from '../../src/shared/intake-gate.mjs';

const F = ORDERDESK_FOLDERS;
const JOB = {
  orderName: 'S64520', needsProof: true,
  source: { orderDeskId: '4979720744' },
  routing: { facility: 'GA', transport: 'FTP' },
};

describe('planMove: Linh\'s folder flow', () => {
  test('proof sent: Processing -> Proofing', () => {
    assert.deepEqual(planMove(JOB, 'proofing', F),
      { folder: 'proofing', folderId: '651474', expectFrom: ['650227'] });
  });

  test('customer approved: Proofing -> Pending Review', () => {
    assert.deepEqual(planMove(JOB, 'review', F),
      { folder: 'review', folderId: '653109', expectFrom: ['651474'] });
  });

  test('files delivered: Pending Review -> the facility folder', () => {
    assert.deepEqual(planMove(JOB, 'facility', F),
      { folder: 'GA', folderId: '73068', expectFrom: ['653109'] });
  });

  test('no proof wanted: straight from Processing to the facility', () => {
    const p = planMove({ ...JOB, needsProof: false, routing: { facility: 'NV' } }, 'facility', F);
    assert.deepEqual(p, { folder: 'NV', folderId: '674352', expectFrom: ['650227'] });
  });

  test('an unrouted order is not moved anywhere', () => {
    assert.match(planMove({ ...JOB, routing: { facility: null } }, 'facility', F).skip, /no facility/);
  });

  test('a job without an OrderDesk id is not moved', () => {
    assert.match(planMove({ ...JOB, source: {} }, 'proofing', F).skip, /no OrderDesk id/);
  });

  test('trial folder overrides are honoured', () => {
    const ids = { ...F, proofing: '711436' };
    assert.equal(planMove(JOB, 'proofing', ids).folderId, '711436');
    assert.deepEqual(planMove(JOB, 'review', ids).expectFrom, ['711436']);
  });
});

describe('checkFrom: never undo a person\'s move', () => {
  const plan = planMove(JOB, 'review', F);
  test('in the expected folder: move', () => assert.equal(checkFrom('651474', plan), 'move'));
  test('already at the destination: nothing to do', () => assert.equal(checkFrom(653109, plan), 'already-there'));
  test('staff moved it to Manual: leave it', () => assert.equal(checkFrom('652268', plan), 'moved-by-someone-else'));
  test('no folder at all: leave it', () => assert.equal(checkFrom(undefined, plan), 'moved-by-someone-else'));
});

describe('updateOrderDeskDetails without a tag', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.ORDERDESK_WRITES; });

  function capture() {
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    return calls;
  }
  const ORDER = { id: '4979720744', folder_id: '651474', tag_name: 'warning', customer: { name: 'keep' } };

  test('switch off: nothing is sent', async () => {
    const calls = capture();
    const r = await updateOrderDeskDetails({ order: ORDER, orderName: 'S64520', folder: 'review' });
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  });

  test('switch on: the folder changes, the tag and everything else stay', async () => {
    process.env.ORDERDESK_WRITES = 'enabled';
    const calls = capture();
    const r = await updateOrderDeskDetails({
      order: ORDER, orderName: 'S64520', folder: 'review', storeId: 's', apiKey: 'k',
    });
    assert.equal(r.applied, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.deepEqual(calls[0].body, { ...ORDER, folder_id: '653109' });
  });

  test('a synthetic order never writes, switch or not', async () => {
    process.env.ORDERDESK_WRITES = 'enabled';
    const calls = capture();
    const r = await updateOrderDeskDetails({ order: ORDER, orderName: 'DEMO-1', folder: 'review' });
    assert.equal(r.skipped, 'synthetic');
    assert.equal(calls.length, 0);
  });
});
