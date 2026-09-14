// The registry replaced two hand-written maps. The first job of these tests is
// to prove it reproduces them exactly, so nothing downstream shifted.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLDERS, folderById, ORDERDESK_FOLDERS, MIRROR_STATUS_BY_ID,
  AWAITING_SHIPMENT_IDS, isModifiable, facilityOf,
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
    // One status is shared on purpose: Missing/Corrupted File and Pending
    // Review both show as "needs_review", as they did before the registry.
    const mirrors = FOLDERS.filter((f) => f.mirror).map((f) => f.mirror);
    const shared = mirrors.filter((m, i) => mirrors.indexOf(m) !== i);
    assert.deepEqual(shared, ['needs_review'], 'unexpected shared mirror status');
  });

  test('every row states modifiable explicitly — a missing field must not read as yes', () => {
    for (const f of FOLDERS) {
      assert.equal(typeof f.modifiable, 'boolean', `${f.name} has no modifiable`);
    }
  });

  test('every id is digits as a string, the shape OrderDesk returns', () => {
    for (const f of FOLDERS) assert.match(f.id, /^\d+$/, `${f.name} has a odd id`);
  });
});

describe('the cutoff', () => {
  test('all five Awaiting Shipment folders are locked', () => {
    assert.deepEqual([...AWAITING_SHIPMENT_IDS].sort(),
      ['3571', '43256', '43257', '674353', '79040'].sort());
    for (const id of AWAITING_SHIPMENT_IDS) {
      assert.equal(isModifiable(id), false, `${id} must be locked`);
    }
  });

  test('production is still open, pickup and completed are not', () => {
    for (const id of ['73068', '73069', '73070', '674352', '42928']) {
      assert.equal(isModifiable(id), true, `production ${id} should be open`);
    }
    for (const id of ['31301', '52437', '52438', '674908', '82463', '3516']) {
      assert.equal(isModifiable(id), false, `${id} should be locked`);
    }
  });

  test('an unknown folder fails CLOSED', () => {
    for (const id of ['999999', '', null, undefined, 'abc', 0]) {
      assert.equal(isModifiable(id), false, `unknown ${String(id)} must not be modifiable`);
    }
  });

  test('Pay By Check is locked — there is no settled balance to add to', () => {
    assert.equal(isModifiable('698334'), false);
  });
});

describe('lookup', () => {
  test('ids match whether passed as string or number', () => {
    assert.equal(folderById('73068')?.name, 'GA');
    assert.equal(folderById(73068)?.name, 'GA');
    assert.equal(isModifiable(3571), false);
  });

  test('facilityOf finds the facility, and null when there is none', () => {
    assert.equal(facilityOf('3571'), 'GA');
    assert.equal(facilityOf('674908'), 'NV');
    assert.equal(facilityOf('665685'), null);
    assert.equal(facilityOf('999999'), null);
  });
});
