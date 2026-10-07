// Kai's test lane (2026-10-07): orders Kai moves to Kai-TEST-QTS run for real,
// but only into the Kai-TEST-* folders, the order's own inbox and the
// /AWS-TEST transfer path. These pin that the lane cannot reach a real order
// or a real folder, and that it is off unless TEST_LANE says exactly "enabled".

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_INTAKE_FOLDER_ID, TEST_FOLDERS, testLaneEnabled, isTestLaneJob, isTestFolder,
} from '../../src/shared/test-lane.mjs';
import { FOLDERS } from '../../src/shared/orderdesk-folders.mjs';
import { ORDERDESK_FOLDERS } from '../../src/shared/intake-gate.mjs';
import { updateOrderDeskDetails } from '../../src/shared/orderdesk-write.mjs';
import { planMove, checkFrom } from '../../src/functions/orderdesk-move/core.mjs';
import { sendProofReadyEmail } from '../../src/shared/zendesk.mjs';
import { isTestClaimed, TEST_CLAIM_CONDITION, CLAIM_CONDITION } from '../../src/shared/job-rows.mjs';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TEST_LANE;
  delete process.env.ORDERDESK_WRITES;
  delete process.env.ZENDESK_SENDS;
});

function capture() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return calls;
}

describe('the switch', () => {
  test('off unless TEST_LANE is exactly "enabled"', () => {
    for (const v of [undefined, '', 'disabled', 'true', '1', 'yes']) {
      assert.equal(testLaneEnabled({ TEST_LANE: v }), false, String(v));
    }
    assert.equal(testLaneEnabled({ TEST_LANE: ' Enabled ' }), true);
  });

  test('a job is a test job only with testLane === true AND the switch on', () => {
    const on = { TEST_LANE: 'enabled' };
    assert.equal(isTestLaneJob({ testLane: true }, on), true);
    assert.equal(isTestLaneJob({ testLane: 'true' }, on), false);
    assert.equal(isTestLaneJob({}, on), false);
    assert.equal(isTestLaneJob({ testLane: true }, {}), false);
  });
});

describe('the folders', () => {
  test('no test folder is one of Linh\'s real folders', () => {
    const real = new Set([
      ...FOLDERS.filter((f) => !/^Kai-TEST/.test(f.name)).map((f) => f.id),
      ...Object.values(ORDERDESK_FOLDERS),
    ]);
    for (const id of [TEST_INTAKE_FOLDER_ID, ...Object.values(TEST_FOLDERS)]) {
      assert.equal(real.has(id), false, id);
      assert.equal(isTestFolder(id), true, id);
    }
  });

  test('every folder a move can name has a test folder', () => {
    for (const key of ['processing', 'proofing', 'review', 'manual', 'sales', 'GA', 'NJ', 'TX', 'NV', 'CA']) {
      assert.ok(TEST_FOLDERS[key], key);
    }
  });

  test('real folders are not test folders', () => {
    for (const id of Object.values(ORDERDESK_FOLDERS)) assert.equal(isTestFolder(id), false, id);
  });
});

describe('OrderDesk moves', () => {
  const ORDER = { id: '5000000001', folder_id: TEST_INTAKE_FOLDER_ID, tag_name: 'x' };

  test('test lane on: moves into the Kai-TEST folder with ORDERDESK_WRITES held', async () => {
    process.env.TEST_LANE = 'enabled';
    const calls = capture();
    const r = await updateOrderDeskDetails({
      order: ORDER, orderName: 'S70001', folder: 'processing', storeId: 's', apiKey: 'k', testLane: true,
    });
    assert.equal(r.applied, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.folder_id, TEST_FOLDERS.processing);
  });

  test('a facility move goes to the one test facility folder, never the real one', async () => {
    process.env.TEST_LANE = 'enabled';
    const calls = capture();
    await updateOrderDeskDetails({
      order: ORDER, orderName: 'S70001', folder: 'GA', storeId: 's', apiKey: 'k', testLane: true,
    });
    assert.equal(calls[0].body.folder_id, '715306');
  });

  test('test lane off: a testLane job is held like any real order', async () => {
    const calls = capture();
    const r = await updateOrderDeskDetails({
      order: ORDER, orderName: 'S70001', folder: 'processing', storeId: 's', apiKey: 'k', testLane: true,
    });
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  });

  test('a real order is still held with the test lane on', async () => {
    process.env.TEST_LANE = 'enabled';
    const calls = capture();
    const r = await updateOrderDeskDetails({
      order: ORDER, orderName: 'S70002', folder: 'processing', storeId: 's', apiKey: 'k',
    });
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  });

  test('a synthetic order never writes, test lane or not', async () => {
    process.env.TEST_LANE = 'enabled';
    const calls = capture();
    const r = await updateOrderDeskDetails({
      order: ORDER, orderName: 'DEMO-1', folder: 'processing', testLane: true,
    });
    assert.equal(r.skipped, 'synthetic');
    assert.equal(calls.length, 0);
  });

  test('pipeline moves walk the test folders', () => {
    const job = { needsProof: true, source: { orderDeskId: '1' }, routing: { facility: 'CA' } };
    assert.deepEqual(planMove(job, 'proofing', TEST_FOLDERS),
      { folder: 'proofing', folderId: '715304', expectFrom: ['711436'] });
    assert.deepEqual(planMove(job, 'review', TEST_FOLDERS),
      { folder: 'review', folderId: '715305', expectFrom: ['715304'] });
    assert.deepEqual(planMove(job, 'facility', TEST_FOLDERS),
      { folder: 'CA', folderId: '715306', expectFrom: ['715305'] });
    // An order sitting in a REAL folder is never moved by the test plan.
    assert.equal(checkFrom('650227', planMove(job, 'proofing', TEST_FOLDERS)), 'moved-by-someone-else');
  });
});

describe('proof email', () => {
  const order = {
    orderName: 'S70001', customerEmail: 'kai-test@example.com', customerName: 'Kai',
    proofUrl: 'https://example.net/proof.html?t=x',
  };
  const secrets = async () => ({
    email: 'z@example.com', 'api-token': 't', subdomain: 'sb', 'assignee-id': '', 'field-id': '',
  });

  test('test lane on: sent to the order\'s own address with ZENDESK_SENDS held', async () => {
    process.env.TEST_LANE = 'enabled';
    const calls = capture();
    const r = await sendProofReadyEmail({ ...order, testLane: true }, { secrets });
    assert.equal(r.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.ticket.requester.email, 'kai-test@example.com');
    assert.match(calls[0].body.ticket.subject, /^\[TEST\] /);
  });

  test('test lane off: held', async () => {
    const calls = capture();
    const r = await sendProofReadyEmail({ ...order, testLane: true }, { secrets });
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  });

  test('a real order is still held with the test lane on', async () => {
    process.env.TEST_LANE = 'enabled';
    const calls = capture();
    const r = await sendProofReadyEmail(order, { secrets });
    assert.equal(r.skipped, 'disabled');
    assert.equal(calls.length, 0);
  });
});

describe('claiming', () => {
  test('the test lane may take over a real-lane row, but only once', () => {
    assert.equal(isTestClaimed({ PK: 'x' }), false);
    assert.equal(isTestClaimed({ PK: 'x', mirror: true, testLane: true }), false);
    assert.equal(isTestClaimed({ PK: 'x', testLane: true }), true);
    assert.ok(TEST_CLAIM_CONDITION.startsWith(CLAIM_CONDITION));
    assert.match(TEST_CLAIM_CONDITION, /attribute_not_exists\(testLane\)/);
  });
});
