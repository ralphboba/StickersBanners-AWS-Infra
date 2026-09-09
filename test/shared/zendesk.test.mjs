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
    const result = await withFlag('disabled', () => sendProofReadyEmail(order));
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
    const { preview } = await withFlag('disabled', () => sendProofReadyEmail(order));
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
    const result = await withFlag('disabled', () => sendProofReadyEmail(order));
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
