// Customer proof approval — run with `npm run test:shared`.
//
// This is the one route the public can reach that changes an order's state, so
// these pin the boundary as much as the happy path: only a signed link gets in,
// only the order named inside that link is touched, only approval is possible,
// and a missing secret closes the door rather than opening it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeProofApprovalHandler, proofFiles } from '../../src/functions/proof-approval/core.mjs';
import { signApprovalToken, approvalUrl } from '../../src/shared/approval-link.mjs';

const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 0, 1);
const CDN = 'https://tiles.example.net';

/** An order sitting at the proof gate, waiting for its customer. */
const pendingOrder = () => ({
  meta: { status: 'proofing', items: [{ itemNo: 1, name: 'Vinyl Banner' }] },
  approval: { status: 'pending', approvalToken: 'task-token-abc' },
});

/**
 * A handler over fake ports that records what it was asked to do, so a test can
 * assert on effects (resume / record) and not just on the response.
 */
function harness({ order = pendingOrder(), secret = SECRET, resumeThrows = false } = {}) {
  const calls = { loadOrder: [], resumed: [], recorded: [] };
  const handler = makeProofApprovalHandler({
    proofCdnBase: CDN,
    now: () => NOW,
    loadSecret: async () => secret,
    loadOrder: async (orderName) => {
      calls.loadOrder.push(orderName);
      return order;
    },
    resumeWorkflow: async (p) => {
      if (resumeThrows) throw new Error('TaskTimedOut');
      calls.resumed.push(p);
    },
    recordApproved: async (orderName, at) => { calls.recorded.push({ orderName, at }); },
  });
  return { handler, calls };
}

const token = (orderName, secret = SECRET) => signApprovalToken({ orderName, secret, now: NOW });

const get = (t) => ({
  rawPath: '/proof',
  requestContext: { http: { method: 'GET', path: '/proof' } },
  queryStringParameters: t === undefined ? null : { t },
});

const approve = (t) => ({
  rawPath: '/proof/approve',
  requestContext: { http: { method: 'POST', path: '/proof/approve' } },
  body: JSON.stringify({ token: t }),
});

const body = (res) => JSON.parse(res.body);

// --- viewing ---------------------------------------------------------------

test('a valid link shows the order and its proof images', async () => {
  const { handler, calls } = harness();
  const res = await handler(get(token('SB-500')));
  assert.equal(res.statusCode, 200);
  const data = body(res);
  assert.equal(data.orderName, 'SB-500');
  assert.equal(data.status, 'pending');
  assert.equal(data.proofs.length, 1);
  assert.equal(data.proofs[0].review, `${CDN}/SB-500/1-1v1.tif_review.jpg`);
  assert.deepEqual(calls.loadOrder, ['SB-500']);
  assert.deepEqual(calls.resumed, [], 'viewing must never approve');
});

test('the view shows the customer their order and nothing else', async () => {
  // Proof links get forwarded. Address, pricing and routing stay internal.
  const order = pendingOrder();
  order.meta = {
    ...order.meta,
    shipping: { state: 'NV', address: '1 Main St' },
    routing: { facility: 'NV' },
    customer: { email: 'someone@example.com' },
  };
  const { handler } = harness({ order });
  const data = body(await handler(get(token('SB-500'))));
  assert.deepEqual(Object.keys(data).sort(), ['orderName', 'proofs', 'status']);
});

// --- approving -------------------------------------------------------------

test('approving resumes the paused workflow and records who did it', async () => {
  const { handler, calls } = harness();
  const res = await handler(approve(token('SB-500')));
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).status, 'approved');
  assert.deepEqual(calls.resumed, [{ taskToken: 'task-token-abc', orderName: 'SB-500' }]);
  assert.deepEqual(calls.recorded, [{ orderName: 'SB-500', at: new Date(NOW).toISOString() }]);
});

test('clicking approve twice is fine and only resumes once', async () => {
  // Customers double-click; forwarded mail gets clicked again days later.
  const { handler, calls } = harness({
    order: { meta: { status: 'proofing', items: [] }, approval: { status: 'approved' } },
  });
  const res = await handler(approve(token('SB-500')));
  assert.equal(res.statusCode, 200);
  assert.equal(body(res).alreadyApproved, true);
  assert.deepEqual(calls.resumed, []);
});

test('an order that is not waiting for approval cannot be approved', async () => {
  const { handler, calls } = harness({
    order: { meta: { status: 'in_queue', items: [] }, approval: undefined },
  });
  const res = await handler(approve(token('SB-500')));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(calls.resumed, []);
});

test('a workflow that already timed out gives the customer a way forward', async () => {
  const { handler, calls } = harness({ resumeThrows: true });
  const res = await handler(approve(token('SB-500')));
  assert.equal(res.statusCode, 410);
  assert.match(body(res).error, /sales@stickersbanners\.com/);
  assert.deepEqual(calls.recorded, [], 'nothing is recorded when the resume failed');
});

test('an order we do not hold is a 404, not a leak', async () => {
  const { handler } = harness({ order: { meta: undefined, approval: undefined } });
  const res = await handler(approve(token('SB-999')));
  assert.equal(res.statusCode, 404);
});

// --- the boundary ----------------------------------------------------------

test('no token, a forged token or an expired one never approves', async () => {
  const expired = signApprovalToken({ orderName: 'SB-500', secret: SECRET, ttlDays: 1, now: NOW - 5 * 86_400_000 });
  const cases = [
    [undefined, 400],
    ['', 400],
    ['garbage', 400],
    [token('SB-500', 'a-different-secret'), 403],
    [expired, 410],
  ];
  for (const [t, expected] of cases) {
    const { handler, calls } = harness();
    const res = await handler(approve(t));
    assert.equal(res.statusCode, expected, `token ${JSON.stringify(t)}`);
    assert.deepEqual(calls.resumed, [], `token ${JSON.stringify(t)} must not approve`);
    assert.deepEqual(calls.loadOrder, [], 'a bad token must not even reach the table');
  }
});

test('a link for one order cannot touch another', async () => {
  // Nothing outside the token names an order, so there is no field to swap.
  const { handler, calls } = harness();
  await handler({
    ...approve(token('SB-500')),
    queryStringParameters: { order: 'SB-501', name: 'SB-501' },
    pathParameters: { name: 'SB-501' },
  });
  assert.deepEqual(calls.loadOrder, ['SB-500']);
  assert.deepEqual(calls.resumed, [{ taskToken: 'task-token-abc', orderName: 'SB-500' }]);
});

test('an unseeded secret closes the door instead of opening it', async () => {
  const { handler, calls } = harness({ secret: '' });
  const res = await handler(approve(token('SB-500')));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(calls.resumed, []);
});

test('there is no customer path to anything but approve', async () => {
  // Linh: no disapprove, no upload. Every other route shape falls through to
  // the read-only view — it can never resume or fail the workflow.
  const { handler, calls } = harness();
  for (const path of ['/proof/reject', '/proof/upload', '/proof/approve/../reject']) {
    const res = await handler({
      rawPath: path,
      requestContext: { http: { method: 'POST', path } },
      body: JSON.stringify({ token: token('SB-500'), reason: 'no', decision: 'reject' }),
    });
    assert.equal(res.statusCode, 200, path);
    assert.equal(body(res).status, 'pending', `${path} must leave the order pending`);
  }
  assert.deepEqual(calls.resumed, []);
});

// --- proof file naming -----------------------------------------------------

test('proof URLs match what the proof service actually wrote', async () => {
  // src/services/proof/main.py: `{itemNo}-1v1.tif`; dzi.py appends _review.jpg.
  const files = proofFiles('SB-1', [{ itemNo: 3, name: 'Banner' }], CDN);
  assert.equal(files[0].review, `${CDN}/SB-1/3-1v1.tif_review.jpg`);
  assert.equal(files[0].dzi, `${CDN}/SB-1/3-1v1.tif.dzi`);
});

test('a hardware-filtered item list keeps its OrderDesk item numbers', async () => {
  // Hardware lines are dropped before printing, so items are not 1..n. The
  // proof files are named by itemNo, not by position.
  const files = proofFiles('SB-1', [{ itemNo: 1 }, { itemNo: 3 }], CDN);
  assert.deepEqual(files.map((f) => f.itemNo), [1, 3]);
  assert.equal(files[1].review, `${CDN}/SB-1/3-1v1.tif_review.jpg`);
});

test('with no CDN configured the page still gets a usable response', async () => {
  const handler = makeProofApprovalHandler({
    now: () => NOW,
    loadSecret: async () => SECRET,
    loadOrder: async () => pendingOrder(),
    resumeWorkflow: async () => {},
    recordApproved: async () => {},
  });
  const data = body(await handler(get(token('SB-500'))));
  assert.deepEqual(data.proofs, []);
});

// --- the whole path, end to end ---------------------------------------------

test('the link we put in the email is the link that approves the order', async () => {
  // The thing this feature exists for: mint the URL exactly as notify-consumer
  // does, then feed what the page would send back and check the workflow
  // resumes. If this passes, an approval reaches us with Linh's program off.
  const url = approvalUrl({
    portalBase: 'https://dash.example.net/proof.html',
    token: signApprovalToken({ orderName: 'SB-77', secret: SECRET, now: NOW }),
  });
  const fromEmail = new URL(url).searchParams.get('t');

  const { handler, calls } = harness();
  const viewed = body(await handler(get(fromEmail)));
  assert.equal(viewed.orderName, 'SB-77');

  const approved = await handler(approve(fromEmail));
  assert.equal(approved.statusCode, 200);
  assert.deepEqual(calls.resumed, [{ taskToken: 'task-token-abc', orderName: 'SB-77' }]);
});
