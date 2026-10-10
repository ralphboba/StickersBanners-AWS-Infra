// End to end, minus the network: the real paid handler, the real paid-time
// re-check and the real Chat fan-out, for an order sitting in every Order Desk
// folder. Order Desk and the Chat spaces are fakes that record what was sent.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { makePaidHandler } from '../../src/functions/shopify-paid/core.mjs';
import { stillAllowed } from '../../src/shared/paid-recheck.mjs';
import { notifyChat } from '../../src/shared/gchat.mjs';
import { FOLDERS, chatFacilityOf } from '../../src/shared/orderdesk-folders.mjs';

const SECRET = 'shh';
const SPACES = { 'webhook-url': 'MAIN', 'webhook-url-GA': 'GA', 'webhook-url-NJ': 'NJ', 'webhook-url-TX': 'TX' };
const hook = (space) => `https://chat.googleapis.com/v1/spaces/${space}/messages?key=k&token=t`;

async function payInFolder({ folderId, folderName }) {
  const sent = [];
  const od = { id: '49', folder_id: folderId, folder_name: folderName, shipping_method: 'FedEx Ground', order_notes: [],
    shipping: { address1: '1 Main', state: 'GA', country: 'US' }, order_items: [{ name: 'X-Banner' }] };
  const change = { orderName: 'S64262', ref: 'CHG-1', orderDeskId: '49', from: 'FedEx Ground', to: 'FedEx 3-Days',
    shippingCents: 1738, taxCents: 0, status: 'pending' };
  const handler = makePaidHandler({
    webhookSecret: async () => SECRET,
    loadPending: async () => change,
    markDone: async () => {},
    markAttention: async () => {},
    // index.mjs's stillAllowed, with the Order Desk read replaced by `od`
    stillAllowed: async (c) => ({ ...stillAllowed(od, c), facility: chatFacilityOf(od.folder_id, od.folder_name) }),
    applyOrderDesk: async () => ({ applied: true, from: 'FedEx Ground' }),
    // index.mjs's notify, with SSM and fetch replaced
    notify: (orderName, text, where = {}) => notifyChat({
      getUrl: async (k) => hook(SPACES[k]), orderName, text, facility: where.facility,
      fetchImpl: async (url) => { sent.push(new URL(url).pathname.split('/')[3]); return { ok: true, status: 200 }; },
    }),
  });
  const raw = JSON.stringify({ name: '#S64262', financial_status: 'paid', total_outstanding: '0.00' });
  const r = await handler({ body: raw, headers: { 'X-Shopify-Topic': 'orders/paid',
    'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SECRET).update(raw).digest('base64') } });
  return { status: r.statusCode, outcome: JSON.parse(r.body), spaces: sent.sort() };
}

describe('Chat routing for an order in every Order Desk folder', () => {
  for (const f of FOLDERS) {
    const want = ['GA', 'NJ', 'TX'].includes(f.facility) ? ['MAIN', f.facility].sort() : ['MAIN'];
    test(`${f.name} (${f.id}) → ${want.join(' + ')}`, async () => {
      const { status, spaces } = await payInFolder({ folderId: f.id, folderName: f.name });
      assert.equal(status, 200);
      assert.deepEqual(spaces, want);
    });
  }
  test('every listed folder with GA/NJ/TX in its name routes to that facility', () => {
    for (const f of FOLDERS) {
      const m = f.name.match(/\b(GA|NJ|TX)\b/);
      if (m) assert.equal(chatFacilityOf(f.id, f.name), m[1], f.name);
    }
  });
  test('a folder added in Order Desk later routes by its name', async () => {
    const cases = [['TX Rush', ['MAIN', 'TX']], ['Hold - NJ', ['MAIN', 'NJ']], ['ga reprint', ['MAIN', 'GA']],
      ['NEXT DAY', ['MAIN']], ['Texas', ['MAIN']], [undefined, ['MAIN']]];
    for (const [folderName, want] of cases) {
      const { spaces, outcome } = await payInFolder({ folderId: '900001', folderName });
      assert.deepEqual(spaces, want.sort(), String(folderName));
      assert.equal(outcome.written, true);   // an unknown folder is open (Kai, 2026-10-08)
    }
  });
});
