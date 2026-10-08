// The registry replaced two hand-written maps. The first job of these tests is
// to prove it reproduces them exactly, so nothing downstream shifted.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLDERS, folderById, ORDERDESK_FOLDERS, MIRROR_STATUS_BY_ID,
  AWAITING_SHIPMENT_IDS, isModifiable, windowOf, facilityOf,
} from '../../src/shared/orderdesk-folders.mjs';

describe('the registry reproduces the maps it replaced', () => {
  test('ORDERDESK_FOLDERS is byte-for-byte the legacy folderLib', () => {
    assert.deepEqual({ ...ORDERDESK_FOLDERS }, {
      processing: '650227',
      proofing: '651474',
      manual: '652268',
      review: '653109',
      sales: '657836',
      GA: '73068',
      NJ: '73069',
      TX: '73070',
      NV: '674352',
      CA: '42928',
    });
  });

  test('every folder the mirror showed before still maps to the same status', () => {
    const before = {
      665685: 'in_queue', 651474: 'proofing', 661019: 'needs_review',
      653109: 'needs_review', 31358: 'awaiting_admin', 31301: 'pickup_ga',
      52437: 'pickup_nj', 52438: 'pickup_tx', 674908: 'pickup_nv', 82463: 'pickup_ca',
    };
    for (const [id, status] of Object.entries(before)) {
      assert.equal(MIRROR_STATUS_BY_ID[id], status, `folder ${id} changed status`);
    }
  });

  test('every open working folder is mirrored, so the customer page can find the order', () => {
    // Kai's test folder is the one deliberate exception (seed-test-row.mjs).
    for (const f of FOLDERS.filter((x) => x.window === 'open' && x.id !== '711436')) {
      assert.ok(MIRROR_STATUS_BY_ID[f.id], `${f.name} (${f.id}) is not mirrored`);
    }
  });

  test('and the production and Awaiting Shipment folders are now covered too', () => {
    for (const fac of ['ga', 'nj', 'tx', 'nv', 'ca']) {
      assert.ok(Object.values(MIRROR_STATUS_BY_ID).includes(`production_${fac}`));
      assert.ok(Object.values(MIRROR_STATUS_BY_ID).includes(`awaiting_ship_${fac}`));
    }
  });
});

describe('integrity', () => {
  test('no duplicate folder ids', () => {
    const ids = FOLDERS.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('no duplicate keys, and no duplicate mirror statuses', () => {
    const keys = FOLDERS.filter((f) => f.key).map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
    // Two statuses are shared on purpose: Missing/Corrupted File and Pending
    // Review both show as "needs_review", as they did before the registry; and
    // the working folders off the board share "in_progress" (customer page only).
    const mirrors = FOLDERS.filter((f) => f.mirror).map((f) => f.mirror);
    const shared = [...new Set(mirrors.filter((m, i) => mirrors.indexOf(m) !== i))];
    assert.deepEqual(shared.sort(), ['in_progress', 'needs_review'], 'unexpected shared mirror status');
  });

  test('every row states its window explicitly, and only with a known value', () => {
    for (const f of FOLDERS) {
      assert.ok(['open', 'restricted', 'closed'].includes(f.window),
        `${f.name} has window ${JSON.stringify(f.window)}`);
    }
  });

  test('every id is digits as a string, the shape OrderDesk returns', () => {
    for (const f of FOLDERS) assert.match(f.id, /^\d+$/, `${f.name} has a odd id`);
  });
});

describe('windows: only Completed Orders is closed (Kai, 2026-10-08)', () => {
  test('every folder except Completed Orders is open — Awaiting Shipment, Awaiting Pickup and Pay By Check too', () => {
    for (const f of FOLDERS.filter((x) => x.id !== '3516')) {
      assert.equal(windowOf(f.id), 'open', `${f.name} should be open`);
    }
    assert.deepEqual([...AWAITING_SHIPMENT_IDS].sort(), ['3571', '43256', '43257', '674353', '79040'].sort());
  });

  test('Completed Orders is closed', () => {
    assert.equal(windowOf('3516'), 'closed');
    assert.equal(isModifiable('3516'), false);
  });

  test('a folder this list does not know is open', () => {
    for (const id of ['999999', 'abc']) {
      assert.equal(windowOf(id), 'open', `unknown ${String(id)}`);
      assert.equal(isModifiable(id), true);
    }
  });
});

describe('lookup', () => {
  test('ids match whether passed as string or number', () => {
    assert.equal(folderById('73068')?.name, 'GA');
    assert.equal(folderById(73068)?.name, 'GA');
    assert.equal(windowOf(3516), 'closed', 'a number id resolves the same as a string');
  });

  test('facilityOf finds the facility, and null when there is none', () => {
    assert.equal(facilityOf('3571'), 'GA');
    assert.equal(facilityOf('674908'), 'NV');
    assert.equal(facilityOf('665685'), null);
    assert.equal(facilityOf('999999'), null);
  });
});
