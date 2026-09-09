// Customer approval links — run with `npm run test:shared`.
//
// This token is the ONLY thing standing between the public internet and
// "approve this order", so the properties below are the security boundary, not
// nice-to-haves: it must name exactly one order, be unforgeable without the
// secret, and expire on its own.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  signApprovalToken, verifyApprovalToken, approvalUrl, LINK_TTL_DAYS,
} from '../../src/shared/approval-link.mjs';

const SECRET = 'a-long-random-secret-value';
const NOW = Date.UTC(2026, 0, 1);

test('a freshly minted token verifies back to the same order', () => {
  const token = signApprovalToken({ orderName: 'SB-10042', secret: SECRET, now: NOW });
  const result = verifyApprovalToken({ token, secret: SECRET, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.orderName, 'SB-10042');
});

test('the order name comes from the token, never from the caller', () => {
  // The whole point: a customer holding a link for SB-1 cannot reach SB-2 by
  // editing anything, because nothing outside the token names an order.
  const token = signApprovalToken({ orderName: 'SB-1', secret: SECRET, now: NOW });
  const [version, payload] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({
    o: 'SB-2',
    e: Math.floor(NOW / 1000) + 86400,
  })).toString('base64url');
  const forged = `${version}.${tampered}.${token.split('.')[2]}`;
  assert.notEqual(payload, tampered);
  assert.deepEqual(
    verifyApprovalToken({ token: forged, secret: SECRET, now: NOW }),
    { ok: false, reason: 'bad-signature' },
  );
});

test('a token signed with a different secret is refused', () => {
  const token = signApprovalToken({ orderName: 'SB-1', secret: 'other-secret', now: NOW });
  assert.deepEqual(
    verifyApprovalToken({ token, secret: SECRET, now: NOW }),
    { ok: false, reason: 'bad-signature' },
  );
});

test('rotating the secret invalidates every outstanding link', () => {
  const token = signApprovalToken({ orderName: 'SB-1', secret: SECRET, now: NOW });
  assert.equal(verifyApprovalToken({ token, secret: `${SECRET}-rotated`, now: NOW }).ok, false);
});

test('junk in never verifies, and never throws', () => {
  const junk = [
    '', null, undefined, 'not-a-token', 'v1.only-two', 'v1.a.b.c',
    'v2.eyJvIjoiU0ItMSJ9.sig', 'v1..', '../../etc/passwd',
  ];
  for (const token of junk) {
    const result = verifyApprovalToken({ token, secret: SECRET, now: NOW });
    assert.equal(result.ok, false, `${JSON.stringify(token)} must not verify`);
  }
});

test("a valid signature over a nonsense payload is still refused", async () => {
  // Signature checks out, claims do not — must not fall through to ok:true.
  const { createHmac } = await import('node:crypto');
  const payload = Buffer.from(JSON.stringify({ e: 'soon' })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`v1.${payload}`).digest('base64url');
  assert.deepEqual(
    verifyApprovalToken({ token: `v1.${payload}.${sig}`, secret: SECRET, now: NOW }),
    { ok: false, reason: 'malformed' },
  );
});

test('no secret means no approval — never an open door', () => {
  const token = signApprovalToken({ orderName: 'SB-1', secret: SECRET, now: NOW });
  assert.deepEqual(
    verifyApprovalToken({ token, secret: '', now: NOW }),
    { ok: false, reason: 'missing' },
  );
});

// --- expiry ----------------------------------------------------------------

test('a link expires on its own', () => {
  const token = signApprovalToken({ orderName: 'SB-1', secret: SECRET, ttlDays: 2, now: NOW });
  const day = 86_400_000;
  assert.equal(verifyApprovalToken({ token, secret: SECRET, now: NOW + day }).ok, true);
  assert.deepEqual(
    verifyApprovalToken({ token, secret: SECRET, now: NOW + 3 * day }),
    { ok: false, reason: 'expired' },
  );
});

test('the link outlives the workflow it resumes', () => {
  // workflow-stack pauses for 7 days. A link that died first would show
  // "bad link" for an order that is really just timed out.
  assert.ok(LINK_TTL_DAYS > 7, `TTL ${LINK_TTL_DAYS}d must outlast the 7-day approval wait`);
});

// --- the emailed URL -------------------------------------------------------

test('approvalUrl carries the token and survives a base with a trailing slash', () => {
  const token = signApprovalToken({ orderName: 'SB 1/2', secret: SECRET, now: NOW });
  for (const base of ['https://x.example/proof.html', 'https://x.example/proof.html/']) {
    const url = approvalUrl({ portalBase: base, token });
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('t'), token);
    assert.equal(verifyApprovalToken({ token: parsed.searchParams.get('t'), secret: SECRET, now: NOW }).orderName, 'SB 1/2');
  }
});
