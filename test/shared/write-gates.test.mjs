// The switches decide whether real orders move and whether a customer's card is
// charged, so the important test is not that "enabled" works — it is that
// everything else does NOT.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSyntheticOrder,
  orderDeskWritesEnabled,
  orderDeskUpgradeWritesEnabled,
  shopifyWritesEnabled,
  blockedReason,
  writeGateStatus,
} from '../../src/shared/write-gates.mjs';

const VARS = ['ORDERDESK_WRITES', 'ORDERDESK_UPGRADE_WRITES', 'SHOPIFY_WRITES'];
const GATES = {
  ORDERDESK_WRITES: orderDeskWritesEnabled,
  ORDERDESK_UPGRADE_WRITES: orderDeskUpgradeWritesEnabled,
  SHOPIFY_WRITES: shopifyWritesEnabled,
};

afterEach(() => { for (const v of VARS) delete process.env[v]; });

describe('write gates', () => {
  test('every switch defaults to off when unset', () => {
    for (const [v, gate] of Object.entries(GATES)) {
      assert.equal(gate(), false, `${v} must be off when unset`);
    }
  });

  test('only the exact word "enabled" arms a switch', () => {
    const nope = ['', ' ', '0', '1', 'true', 'TRUE', 'yes', 'on', 'disabled',
                  'enable', 'enabled!', 'not-enabled', 'enabled enabled'];
    for (const [v, gate] of Object.entries(GATES)) {
      for (const value of nope) {
        process.env[v] = value;
        assert.equal(gate(), false, `${v}="${value}" must not arm the write`);
      }
      delete process.env[v];
    }
  });

  test('case and surrounding whitespace are tolerated', () => {
    for (const [v, gate] of Object.entries(GATES)) {
      for (const value of ['enabled', 'ENABLED', ' Enabled ', '\tenabled\n']) {
        process.env[v] = value;
        assert.equal(gate(), true, `${v}="${value}" should arm the write`);
      }
      delete process.env[v];
    }
  });

  test('the switches are independent — arming one arms nothing else', () => {
    for (const armed of VARS) {
      process.env[armed] = 'enabled';
      for (const [v, gate] of Object.entries(GATES)) {
        assert.equal(gate(), v === armed, `${armed} armed: ${v} should be ${v === armed}`);
      }
      delete process.env[armed];
    }
  });
});

describe('synthetic orders', () => {
  test('DEMO- and ZZ- are synthetic, in any case', () => {
    for (const n of ['DEMO-1', 'demo-1', 'ZZ-9', 'zz-9', 'Demo-abc']) {
      assert.equal(isSyntheticOrder(n), true, `${n} must be synthetic`);
    }
  });

  test('real order names are not', () => {
    for (const n of ['S59131', '000123', 'D169', 'ADEMO-1', 'AZZ-1', '', null, undefined]) {
      assert.equal(isSyntheticOrder(n), false, `${String(n)} must not be synthetic`);
    }
  });
});

describe('blockedReason', () => {
  test('a synthetic order is blocked even with the switch armed', () => {
    process.env.SHOPIFY_WRITES = 'enabled';
    assert.deepEqual(blockedReason('DEMO-1', shopifyWritesEnabled), { skipped: 'synthetic' });
  });

  test('synthetic is reported before the switch, so the reason is the real one', () => {
    assert.deepEqual(blockedReason('DEMO-1', shopifyWritesEnabled), { skipped: 'synthetic' });
  });

  test('a real order is blocked while the switch is off', () => {
    assert.deepEqual(blockedReason('S59131', shopifyWritesEnabled), { skipped: 'disabled' });
  });

  test('null means allowed: real order, switch armed', () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    assert.equal(blockedReason('S59131', orderDeskUpgradeWritesEnabled), null);
  });
});

describe('writeGateStatus', () => {
  test('reports all three as disabled by default', () => {
    assert.deepEqual(writeGateStatus(), {
      orderDeskWrites: 'disabled',
      orderDeskUpgradeWrites: 'disabled',
      shopifyWrites: 'disabled',
    });
  });

  test('shouts in caps for whichever is armed', () => {
    process.env.ORDERDESK_UPGRADE_WRITES = 'enabled';
    assert.deepEqual(writeGateStatus(), {
      orderDeskWrites: 'disabled',
      orderDeskUpgradeWrites: 'ENABLED',
      shopifyWrites: 'disabled',
    });
  });
});
