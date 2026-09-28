import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { upgradeMessage, isChatWebhook, sendChat } from '../../src/shared/gchat.mjs';

const HOOK = 'https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t';

describe('upgradeMessage', () => {
  test('one line, cents exact', () => {
    assert.equal(upgradeMessage({ orderName: 'S64262', from: 'FedEx Ground', to: 'FedEx 3-Days', amount: 17.38, tax: 1.04 }),
      'S64262 upgraded FedEx Ground → FedEx 3-Days · +$17.38 + $1.04 tax');
  });
  test('no tax, pickup conversion, test marker', () => {
    assert.equal(upgradeMessage({ orderName: 'S1', from: 'Georgia Warehouse', to: 'FedEx 2-Days', amount: 128.11, converted: true, test: true }),
      'S1 changed from pickup Georgia Warehouse → FedEx 2-Days · +$128.11 (TEST)');
  });
  test('refuses a non-positive amount', () => {
    assert.throws(() => upgradeMessage({ orderName: 'S1', from: 'a', to: 'b', amount: 0 }));
  });
});

describe('sendChat', () => {
  test('posts the text as JSON to the webhook', async () => {
    let seen;
    const r = await sendChat({ webhookUrl: HOOK, orderName: 'S1', text: 'hi',
      fetchImpl: async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200 }; } });
    assert.deepEqual(r, { sent: true, status: 200 });
    assert.equal(seen.url, HOOK);
    assert.deepEqual(seen.body, { text: 'hi' });
  });
  test('never for DEMO-/ZZ- orders, never without a real Chat webhook', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { ok: true }; };
    assert.equal((await sendChat({ webhookUrl: HOOK, orderName: 'DEMO-1', text: 'x', fetchImpl })).skipped, 'synthetic');
    assert.equal((await sendChat({ webhookUrl: '', orderName: 'S1', text: 'x', fetchImpl })).skipped, 'no_webhook');
    for (const bad of ['https://mail.google.com/mail/u/0/#chat/space/AAQ', 'http://chat.googleapis.com/v1/spaces/A/messages?key=k&token=t',
      'https://evil.example/v1/spaces/A/messages?key=k&token=t', 'https://chat.googleapis.com/v1/spaces/A/messages']) {
      assert.equal(isChatWebhook(bad), false, bad);
      assert.equal((await sendChat({ webhookUrl: bad, orderName: 'S1', text: 'x', fetchImpl })).skipped, 'not_a_chat_webhook');
    }
    assert.equal(called, false);
  });
});
