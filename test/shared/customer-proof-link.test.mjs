// order-api hands the dashboard the customer's approval page link.
import test from 'node:test';
import assert from 'node:assert/strict';

import { customerProofLink } from '../../src/functions/order-api/customer-link.mjs';
import { verifyApprovalToken } from '../../src/shared/approval-link.mjs';

const SETTINGS = { 'link-secret': 's3cret', 'portal-base': 'https://d1.example.net/proof.html' };
const proofing = (over = {}) => ({ orderName: 'S64657', status: 'proofing', ...over });

test('a real order waiting in Proofing gets the same signed link the email carries', () => {
  const url = customerProofLink(proofing(), SETTINGS);
  assert.ok(url.startsWith('https://d1.example.net/proof.html?t='));
  const t = new URL(url).searchParams.get('t');
  const v = verifyApprovalToken({ token: t, secret: 's3cret' });
  assert.equal(v.ok, true);
  assert.equal(v.orderName, 'S64657');
});

test('no link outside Proofing, for mirror rows, or for demo orders', () => {
  assert.equal(customerProofLink(proofing({ status: 'pickup_ga' }), SETTINGS), undefined);
  assert.equal(customerProofLink(proofing({ mirror: true }), SETTINGS), undefined);
  assert.equal(customerProofLink(proofing({ orderName: 'DEMO-3' }), SETTINGS), undefined);
});

test('no link unless both approval settings are seeded (same rule as the email)', () => {
  assert.equal(customerProofLink(proofing(), {}), undefined);
  assert.equal(customerProofLink(proofing(), { 'link-secret': 's3cret' }), undefined);
  assert.equal(customerProofLink(proofing(), { 'portal-base': 'https://x/p.html' }), undefined);
});
