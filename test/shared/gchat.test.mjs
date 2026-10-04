import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { upgradeMessage, isChatWebhook, sendChat, notifyChat, facilitySpaceKey } from '../../src/shared/gchat.mjs';

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

describe('notifyChat: main space + facility space', () => {
  const MAIN = 'https://chat.googleapis.com/v1/spaces/MAIN/messages?key=k&token=t';
  const GA = 'https://chat.googleapis.com/v1/spaces/GA/messages?key=k&token=t';
  const urls = { 'webhook-url': MAIN, 'webhook-url-GA': GA };
  const getUrl = async (k) => { if (!urls[k]) throw new Error('ParameterNotFound'); return urls[k]; };
  const recorder = (fail = new Set()) => {
    const hit = [];
    return { hit, fetchImpl: async (url, init) => { hit.push([url, JSON.parse(init.body).text]); if (fail.has(url)) throw new Error('down'); return { ok: true, status: 200 }; } };
  };

  test('only GA/NJ/TX have a space', () => {
    assert.equal(facilitySpaceKey('GA'), 'webhook-url-GA');
    assert.equal(facilitySpaceKey('nj'), 'webhook-url-NJ');
    assert.equal(facilitySpaceKey('TX'), 'webhook-url-TX');
    for (const f of ['NV', 'CA', null, undefined, '']) assert.equal(facilitySpaceKey(f), null);
  });
  test('GA order: same line to main and GA', async () => {
    const { hit, fetchImpl } = recorder();
    const r = await notifyChat({ getUrl, orderName: 'S1', text: 'line', facility: 'GA', fetchImpl });
    assert.deepEqual(hit.sort(), [[GA, 'line'], [MAIN, 'line']]);
    assert.equal(r.sent, true);
    assert.equal(r.facility.name, 'GA');
    assert.equal(r.facility.sent, true);
  });
  test('NV / unknown folder: main only', async () => {
    for (const facility of ['NV', null]) {
      const { hit, fetchImpl } = recorder();
      const r = await notifyChat({ getUrl, orderName: 'S1', text: 'line', facility, fetchImpl });
      assert.deepEqual(hit, [[MAIN, 'line']]);
      assert.equal(r.facility, undefined);
    }
  });
  test('facility space not set up: main still sent, no throw', async () => {
    const { hit, fetchImpl } = recorder();
    const r = await notifyChat({ getUrl, orderName: 'S1', text: 'line', facility: 'TX', fetchImpl });
    assert.deepEqual(hit, [[MAIN, 'line']]);
    assert.equal(r.sent, true);
    assert.equal(r.facility.skipped, 'no_webhook');
  });
  test('facility space down: main unaffected', async () => {
    const { fetchImpl } = recorder(new Set([GA]));
    const r = await notifyChat({ getUrl, orderName: 'S1', text: 'line', facility: 'GA', fetchImpl });
    assert.equal(r.sent, true);
    assert.equal(r.facility.skipped, 'network_error');
  });
  test('synthetic orders send nowhere', async () => {
    const { hit, fetchImpl } = recorder();
    await notifyChat({ getUrl, orderName: 'DEMO-1', text: 'line', facility: 'GA', fetchImpl });
    assert.deepEqual(hit, []);
  });
});
