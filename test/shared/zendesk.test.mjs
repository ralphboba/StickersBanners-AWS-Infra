// The customer email kill switch — run with `npm run test:shared`.
//
// sendProofReadyEmail is the only code in the project that contacts a real
// customer. These pin that it stays held until someone deliberately arms it,
// because the whole point of running real orders through the pipeline before
// go-live is that nobody's inbox is touched while we watch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sendProofReadyEmail, zendeskSendsEnabled, proofEmailHtml } from '../../src/shared/zendesk.mjs';

/** Run body with ZENDESK_SENDS set to `value` (unset it with undefined). */
async function withFlag(value, body) {
  const before = process.env.ZENDESK_SENDS;
  if (value === undefined) delete process.env.ZENDESK_SENDS;
  else process.env.ZENDESK_SENDS = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.ZENDESK_SENDS;
    else process.env.ZENDESK_SENDS = before;
  }
}

/** A fetch that fails the test if anything actually tries to leave the box. */
function forbidNetwork() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`network call must not happen while held: ${url}`);
  };
  return () => { globalThis.fetch = real; };
}

const order = {
  orderName: 'SB-4242',
  customerEmail: 'customer@example.com',
  customerName: 'A Customer',
  proofUrl: 'https://dash.example.net/proof.html?t=v1.abc.def',
};

// --- the flag itself -------------------------------------------------------

test('the switch is off unless it says exactly "enabled"', async () => {
  for (const value of [undefined, '', 'disabled', 'no', 'false', '0', 'true', '1', 'yes', 'ENABLE']) {
    await withFlag(value, () => {
      assert.equal(zendeskSendsEnabled(), false, `${JSON.stringify(value)} must not arm it`);
    });
  }
});

test('"enabled" arms it, and case and padding do not matter', async () => {
  for (const value of ['enabled', 'ENABLED', '  Enabled  ']) {
    await withFlag(value, () => {
      assert.equal(zendeskSendsEnabled(), true, `${JSON.stringify(value)} must arm it`);
    });
  }
});

// --- the held path ---------------------------------------------------------

test('a real order is held, and nothing leaves the box', async () => {
  const restore = forbidNetwork();
  try {
    const result = await withFlag('disabled', () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
    assert.equal(result.sent, false);
    assert.equal(result.skipped, 'disabled');
  } finally {
    restore();
  }
});

test('the held result says exactly who would have been emailed', async () => {
  // The reason to run real orders with the email held is to SEE what each
  // customer would have received. A bare "skipped" would be useless.
  const restore = forbidNetwork();
  try {
    const { preview } = await withFlag('disabled', () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
    assert.equal(preview.to, 'customer@example.com');
    assert.equal(preview.subject, 'Proof for Order SB-4242 is ready to be reviewed');
    assert.equal(preview.proofUrl, order.proofUrl, 'the real signed link, not a placeholder');
  } finally {
    restore();
  }
});

test('holding the email reads no Zendesk credentials at all', async () => {
  // The held path returns before getGroup('zendesk'), so the pipeline can be
  // exercised end to end before the API token is even seeded or rotated.
  const restore = forbidNetwork();
  try {
    const result = await withFlag('disabled', () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
    assert.equal(result.sent, false);
  } finally {
    restore();
  }
  // forbidNetwork() would have thrown on the SSM/Zendesk call; reaching here
  // means neither was attempted.
});

// --- guards that hold regardless of the flag -------------------------------

test('synthetic orders can never email anyone, even armed', async () => {
  const restore = forbidNetwork();
  try {
    for (const orderName of ['DEMO-1', 'demo-9', 'ZZ-TEST', 'zz-1']) {
      const result = await withFlag('enabled', () => sendProofReadyEmail({ ...order, orderName }));
      assert.equal(result.sent, false, orderName);
      assert.equal(result.skipped, 'synthetic', orderName);
    }
  } finally {
    restore();
  }
});

test('an order with no customer email fails loudly rather than half-sending', async () => {
  await withFlag('disabled', async () => {
    await assert.rejects(
      () => sendProofReadyEmail({ ...order, customerEmail: '' }),
      /no customer email for order SB-4242/,
    );
  });
});

// --- the composed mail -----------------------------------------------------

test('the held body is the real mail, carrying the approval link', async () => {
  const html = proofEmailHtml('SB-4242', order.proofUrl);
  assert.ok(html.includes(order.proofUrl), 'the customer link must be in the body');
  assert.ok(html.includes('SB-4242'));
  assert.ok(html.includes('sales@stickersbanners.com'), 'revisions go to sales@, per Linh');
  assert.ok(!/upload/i.test(html), 'no upload path is ever offered to the customer');
});

// --- the redirect, Linh's condition for the full-day test ------------------
// "Can you change the email so it's only sending to you or someone else, like
// not to customer? Just hard code the recipient's email so cx doesn't get 2
// proof emails by monday." He moves the orders back to QTS afterwards and his
// own program mails them again, so any address we touch is one that gets two.

/** Run body with both switches set, restoring whatever was there. */
async function withEnv(vars, body) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Stand-in for the SSM lookup, so these tests need no credentials. */
const fakeSecrets = async () => ({
  subdomain: 'example', email: 'agent@example.com', 'api-token': 'tok',
  'assignee-id': '0', 'field-id': '0',
});

/** Capture the ticket that would go to Zendesk instead of sending it. */
function captureTicket() {
  const real = globalThis.fetch;
  const seen = {};
  globalThis.fetch = async (url, init) => {
    seen.url = String(url);
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ ticket: { id: 1 } }) };
  };
  return [seen, () => { globalThis.fetch = real; }];
}

test('proofEmailRedirect: unset and blank both mean no redirect', async () => {
  const { proofEmailRedirect } = await import('../../src/shared/zendesk.mjs');
  assert.equal(proofEmailRedirect({}), null);
  assert.equal(proofEmailRedirect({ PROOF_EMAIL_REDIRECT: '   ' }), null);
  assert.equal(proofEmailRedirect({ PROOF_EMAIL_REDIRECT: ' a@b.com ' }), 'a@b.com');
});

test('under a redirect the customer address never reaches Zendesk', async () => {
  const [seen, restore] = captureTicket();
  try {
    await withEnv({ ZENDESK_SENDS: 'enabled', PROOF_EMAIL_REDIRECT: 'tester@stickersbanners.com' },
      () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
  } finally { restore(); }

  // This is the whole promise made to Linh: search the entire outgoing
  // payload, not just the fields we remembered to check.
  const wire = JSON.stringify(seen.body);
  assert.ok(!wire.includes(order.customerEmail),
    'customer address must appear nowhere in the ticket');
  assert.equal(seen.body.ticket.requester.email, 'tester@stickersbanners.com');
  assert.deepEqual(seen.body.ticket.email_ccs, [{ user_email: 'tester@stickersbanners.com' }]);
});

test('a redirected email is obvious in the inbox and in the log', async () => {
  const [seen, restore] = captureTicket();
  let result;
  try {
    result = await withEnv({ ZENDESK_SENDS: 'enabled', PROOF_EMAIL_REDIRECT: 'tester@x.com' },
      () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
  } finally { restore(); }

  assert.ok(seen.body.ticket.subject.startsWith('[TEST] '));
  assert.ok(seen.body.ticket.requester.name.startsWith('[TEST] '));
  // Who it was meant for is kept, so the run stays auditable.
  assert.equal(result.preview.redirected, true);
  assert.equal(result.preview.intendedFor, order.customerEmail);
  assert.equal(result.preview.to, 'tester@x.com');
});

test('without a redirect the customer is the recipient, unchanged', async () => {
  const [seen, restore] = captureTicket();
  try {
    await withEnv({ ZENDESK_SENDS: 'enabled', PROOF_EMAIL_REDIRECT: undefined },
      () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
  } finally { restore(); }

  assert.equal(seen.body.ticket.requester.email, order.customerEmail);
  assert.deepEqual(seen.body.ticket.email_ccs, [{ user_email: order.customerEmail }]);
  assert.ok(!seen.body.ticket.subject.includes('[TEST]'));
});

test('a redirect does not arm anything: sends still held means nothing sent', async () => {
  const restore = forbidNetwork();
  try {
    const r = await withEnv({ ZENDESK_SENDS: 'disabled', PROOF_EMAIL_REDIRECT: 'tester@x.com' },
      () => sendProofReadyEmail(order, { secrets: fakeSecrets }));
    assert.equal(r.sent, false);
    assert.equal(r.skipped, 'disabled');
  } finally { restore(); }
});
