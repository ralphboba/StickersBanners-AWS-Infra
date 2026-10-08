// Add-ons (Kai, 2026-10-08): the list, the price (shipping re-priced like
// checkout every time), the Order Desk write, the payment guards, the Chat line.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { addOnsFrom, resolveAddOns } from '../../src/shared/addon-catalog.mjs';
import { quoteOrderChange } from '../../src/shared/shopify-pricing.mjs';
import { __resetShopifyClient } from '../../src/shared/shopify-fetch.mjs';
import { applyShippingUpgrade } from '../../src/shared/orderdesk-write.mjs';
import { stillAllowed } from '../../src/shared/paid-recheck.mjs';
import { addOnMessage } from '../../src/shared/gchat.mjs';
import { paidWithChange } from '../../src/functions/shipping-change-reconcile/core.mjs';
import { addOnLinesOnOrder } from '../../src/functions/shopify-paid/core.mjs';

const V = (n) => `gid://shopify/ProductVariant/${n}`;
const PRODUCTS = [
  { id: 'P1', title: 'Banner Stands', status: 'ACTIVE', productType: 'Stand', onlineStoreUrl: 'https://x/p1',
    variants: { nodes: [
      { id: V(1), title: "10'x8' Telescopic Adjustable Stand", sku: 'SKUBS08X10', price: '149.00', availableForSale: true },
      { id: V(2), title: "20'x8' Aluminum Banner Stand", sku: 'SKUBS08X20', price: '349.00', availableForSale: true },
    ] } },
  { id: 'P2', title: 'X-Banner', status: 'ACTIVE', productType: 'Banner', onlineStoreUrl: 'https://x/p2',
    variants: { nodes: [
      { id: V(3), title: '30 / 69 / Single Banner + Stand', sku: 'SKUXB', price: '80.00', availableForSale: true },
      { id: V(4), title: '30 / 69 / Stand Only', sku: 'SKUXBS', price: '50.00', availableForSale: true },
    ] } },
  { id: 'P3', title: 'Red Carpet', status: 'ACTIVE', productType: 'Carpet', onlineStoreUrl: 'https://x/p3',
    variants: { nodes: [{ id: V(5), title: "3' x 8'", sku: 'SKURC0308', price: '72.00', availableForSale: true }] } },
  { id: 'P4', title: 'Fancy Test Copy', status: 'DRAFT', productType: 'Stand', onlineStoreUrl: null,
    variants: { nodes: [{ id: V(6), title: 'x', sku: 'S', price: '1.00', availableForSale: true }] } },
  { id: 'P5', title: 'Hidden stand', status: 'ACTIVE', productType: 'Stand', onlineStoreUrl: null,
    variants: { nodes: [{ id: V(7), title: 'x', sku: 'S2', price: '1.00', availableForSale: true }] } },
];

describe('the add-on list', () => {
  const list = addOnsFrom(PRODUCTS);
  test('every size of a stand or carpet; only "Stand Only" of a printed product', () => {
    assert.deepEqual(list.map((p) => [p.title, p.options.map((o) => o.sku)]),
      [['Banner Stands', ['SKUBS08X10', 'SKUBS08X20']], ['X-Banner', ['SKUXBS']], ['Red Carpet', ['SKURC0308']]]);
    assert.equal(list[0].options[0].price, 14900);
  });
  test('drafts and products hidden from the store are left out (blocked by Kai)', () => {
    assert.ok(!list.some((p) => /Fancy|Hidden/.test(p.title)));
  });
  test('a request may only add what is on the list, any quantity, same item merged', () => {
    assert.deepEqual(resolveAddOns([{ variantId: V(6), quantity: 1 }], list), { error: 'addon_not_offered' });
    const r = resolveAddOns([{ variantId: V(1), quantity: 2 }, { variantId: V(1), quantity: 3 }, { variantId: V(5), quantity: 0 }], list);
    assert.deepEqual(r.addOns.map((a) => [a.sku, a.quantity, a.product]), [['SKUBS08X10', 5, 'Banner Stands']]);
  });
});

// ── a Shopify that prices like the store ─────────────────────────────────
// Rates rise with the subtotal; the staged edit adds what it is told.
const ADDRESS = { address1: '1 Main', city: 'Suwanee', provinceCode: 'GA', zip: '30024', countryCode: 'US' };
function rateAt(subtotalCents) {
  // Ground $15.70 up to $100, $25.15 up to $300, $44.05 above; 3-Days = Ground + $17.38.
  const g = subtotalCents <= 10000 ? 1570 : subtotalCents <= 30000 ? 2515 : 4405;
  return { 'FedEx Ground': g, 'FedEx 3-Days': g + 1738, 'FedEx 2-Days': g + 3400 };
}
const reply = (data) => ({ ok: true, status: 200, text: async () => '',
  json: async () => ({ data, extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } } }) });
const amt = (c) => ({ shopMoney: { amount: (c / 100).toFixed(2), currencyCode: 'USD' } });

function fakeShopify({ subtotal = 796, shipping = 1570, taxRate = 0.06, title = 'FedEx Ground' } = {}) {
  const calls = [];
  const st = { sub: subtotal, ship: shipping, title };
  const paidTotal = subtotal + shipping + Math.round((subtotal + shipping) * taxRate);
  const totals = () => {
    const tax = Math.round((st.sub + st.ship) * taxRate);
    const total = st.sub + st.ship + tax;
    return { subtotalPriceSet: amt(st.sub), totalPriceSet: amt(total), totalOutstandingSet: amt(total - paidTotal) };
  };
  const fetchImpl = async (_u, init) => {
    const b = JSON.parse(init.body);
    calls.push(b.query.match(/(query|mutation)\s+(\w+)/)?.[2]);
    if (/RateCheck/.test(b.query)) {
      const sub = Math.round(Number(b.variables.input.lineItems[0].originalUnitPriceWithCurrency.amount) * 100);
      const r = rateAt(sub);
      return reply({ draftOrderCalculate: { userErrors: [], calculatedDraftOrder: {
        availableShippingRates: Object.entries(r).map(([t, c]) => ({ title: t, price: { amount: (c / 100).toFixed(2), currencyCode: 'USD' } })) } } });
    }
    if (/EditBeginItems/.test(b.query)) {
      return reply({ orderEditBegin: { userErrors: [], calculatedOrder: { id: 'gid://shopify/CalculatedOrder/9', ...totals(),
        shippingLines: [{ id: 'gid://shopify/CalculatedShippingLine/77', title: st.title, price: amt(st.ship) }],
        lineItems: { nodes: [{ id: 'gid://shopify/CalculatedLineItem/500', quantity: 1 }] } } } });
    }
    if (/EditItems/.test(b.query)) {
      const out = {};
      for (const [k, v] of Object.entries(b.variables)) {
        if (/^v\d+$/.test(k)) st.sub += ({ [V(1)]: 14900, [V(5)]: 7200 }[v]) * b.variables[`q${k.slice(1)}`];
      }
      for (const m of b.query.matchAll(/(\w+): orderEdit/g)) out[m[1]] = { userErrors: [], calculatedOrder: { id: 'C', ...totals() } };
      return reply(out);
    }
    if (/EditShip/.test(b.query)) {
      st.ship = Math.round(Number(b.variables.add.price.amount) * 100); st.title = b.variables.add.title;
      return reply({ removed: { userErrors: [] }, added: { userErrors: [], calculatedOrder: { id: 'C', ...totals() } } });
    }
    throw new Error(`unexpected ${b.query.slice(0, 40)}`);
  };
  const order = {
    id: 'gid://shopify/Order/1', name: 'S70001', currency: 'USD', subtotalCents: subtotal, currentSubtotalCents: subtotal,
    currentTotalCents: paidTotal, outstandingCents: 0, orderTaxExempt: false, customerTaxExempt: false,
    shippingAddress: ADDRESS, lineItemIds: ['gid://shopify/LineItem/500'],
    shippingLines: [{ id: 'gid://shopify/ShippingLine/77', title, originalCents: shipping, discountedCents: shipping }],
  };
  return { fetchImpl, calls, order, st };
}

describe('pricing an add-on (shipping re-priced like checkout, every time)', () => {
  beforeEach(() => { __resetShopifyClient(); });
  const ARGS = { shop: 's.myshopify.com', token: 't' };

  test('a $149 stand on a $7.96 order: Ground goes from the $15.70 band to the $25.15 band', async () => {
    const f = fakeShopify();
    const q = await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: f.order, addOns: [{ variantId: V(1), quantity: 1 }], expectedFrom: 'FedEx Ground' });
    assert.equal(q.ok, true, q.reason);
    assert.equal(q.itemsCents, 14900);
    assert.equal(q.shippingCents, 2515 - 1570);   // checkout's rate at the new subtotal, minus what was paid
    assert.equal(f.st.ship, 2515);                // the order's line is now exactly checkout's
    assert.equal(q.totalCents, q.itemsCents + q.shippingCents + q.taxCents);
    assert.equal(q.taxCents, Math.round((14900 + 945) * 0.06));
  });

  test('items that stay in the same band leave shipping alone (no shipping restage)', async () => {
    const f = fakeShopify({ subtotal: 796 });
    const q = await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: f.order, addOns: [{ variantId: V(5), quantity: 1 }] });
    assert.equal(q.ok, true, q.reason);
    assert.equal(q.shippingCents, 0);
    assert.ok(!f.calls.includes('EditShip'));
  });

  test('an add-on with a faster service: one edit, the faster rate at the new subtotal', async () => {
    const f = fakeShopify();
    const q = await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: f.order, to: 'FedEx 3-Days', addOns: [{ variantId: V(1), quantity: 1 }] });
    assert.equal(q.ok, true, q.reason);
    assert.equal(f.st.title, 'FedEx 3-Days');
    assert.equal(f.st.ship, 2515 + 1738);
    assert.equal(q.shippingCents, 2515 + 1738 - 1570);
  });

  test('a pickup keeps its $0 pickup line; add-ons are collected with it', async () => {
    const f = fakeShopify({ shipping: 0, title: 'Georgia Warehouse' });
    const q = await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: { ...f.order, shippingAddress: null }, addOns: [{ variantId: V(1), quantity: 2 }] });
    assert.equal(q.ok, true, q.reason);
    assert.equal(q.shippingCents, 0);
    assert.equal(q.itemsCents, 29800);
    assert.ok(!f.calls.includes('RateCheck'));
    const both = await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: f.order, to: 'FedEx Ground', addOns: [{ variantId: V(1), quantity: 1 }] });
    assert.equal(both.reason, 'convert_with_addons');
  });

  test('refuses what checkout could not reproduce (discount, balance due)', async () => {
    const f = fakeShopify();
    const disc = { ...f.order, shippingLines: [{ ...f.order.shippingLines[0], discountedCents: 0 }] };
    assert.equal((await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: disc, addOns: [{ variantId: V(1), quantity: 1 }] })).reason, 'shipping_discounted');
    assert.equal((await quoteOrderChange({ ...ARGS, fetchImpl: f.fetchImpl, order: { ...f.order, outstandingCents: 100 }, addOns: [{ variantId: V(1), quantity: 1 }] })).reason, 'balance_due');
  });
});

describe('after payment: Order Desk', () => {
  const env = process.env.ORDERDESK_UPGRADE_WRITES;
  beforeEach(() => { process.env.ORDERDESK_UPGRADE_WRITES = 'enabled'; });
  afterEach(() => { if (env === undefined) delete process.env.ORDERDESK_UPGRADE_WRITES; else process.env.ORDERDESK_UPGRADE_WRITES = env; });

  const fresh = { id: 49, source_id: 'S70001', shipping_method: 'FedEx Ground', order_total: 25.08, shipping_total: 15.7, tax_total: 1.42,
    order_items: [{ id: 1, name: 'Custom Vinyl Banners', code: 'SKUVB', quantity: 1, price: 7.96 }], order_notes: [] };
  const run = async (over, order = fresh) => {
    const puts = [];
    const fetchImpl = async (url, init = {}) => {
      if (init.method === 'PUT') { puts.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ order }) };
    };
    const r = await applyShippingUpgrade({ orderDeskId: '49', orderName: 'S70001', toMethod: 'FedEx Ground', amount: 9.45, tax: 9.51,
      invoiceRef: 'CHG-1', storeId: 's', apiKey: 'k', fetchImpl, items: 149,
      addOns: [{ sku: 'SKUBS08X10', product: 'Banner Stands', title: "10'x8' Telescopic Adjustable Stand", quantity: 1, unitCents: 14900 }], ...over });
    return { r, put: puts[0] };
  };

  test('the item is added, every total moves by what was paid, the folder and other items stay', async () => {
    const { r, put } = await run();
    assert.equal(r.applied, true, r.error);
    assert.deepEqual(put.order_items.at(-1), { name: "Banner Stands - 10'x8' Telescopic Adjustable Stand", code: 'SKUBS08X10', quantity: 1, price: 149 });
    assert.equal(put.order_items.length, 2);
    assert.equal(put.order_total, (25.08 + 149 + 9.45 + 9.51).toFixed(2));
    assert.equal(put.shipping_total, (15.7 + 9.45).toFixed(2));
    assert.equal(put.tax_total, (1.42 + 9.51).toFixed(2));
    assert.equal(put.shipping_method, 'FedEx Ground');
    assert.equal(put.folder_id, undefined);
    assert.match(put.order_notes.at(-1).content, /Added by customer: Banner Stands 10'x8' Telescopic Adjustable Stand \(SKUBS08X10\) x1 \+\$149\.00.*\(CHG-1\)/);
  });

  test('a pickup that only adds items stays a pickup (no address needed)', async () => {
    const { r, put } = await run({ toMethod: 'Georgia Warehouse', amount: 0 }, { ...fresh, shipping_method: 'Georgia Warehouse', shipping_total: 0 });
    assert.equal(r.applied, true, r.error);
    assert.equal(put.shipping_method, 'Georgia Warehouse');
  });

  test('a repeat is refused by its reference', async () => {
    const { r } = await run({}, { ...fresh, order_notes: [{ content: 'Added by customer … (CHG-1)' }] });
    assert.equal(r.skipped, 'duplicate');
  });
});

describe('payment guards and Chat', () => {
  const change = { to: 'FedEx Ground', from: 'FedEx Ground', addOns: [{ sku: 'SKUBS08X10' }], addedLineItemIds: ['gid://shopify/LineItem/900'] };
  test('paid only when nothing is owed AND the add-on lines are on the order', () => {
    const order = { outstandingCents: 0, shippingLines: [{ title: 'FedEx Ground' }], lineItemIds: ['gid://shopify/LineItem/500', 'gid://shopify/LineItem/900'] };
    assert.equal(paidWithChange(order, change), true);
    assert.equal(paidWithChange({ ...order, lineItemIds: ['gid://shopify/LineItem/500'] }, change), false);
    assert.equal(addOnLinesOnOrder([{ id: 900, current_quantity: 1 }], change), true);
    assert.equal(addOnLinesOnOrder([{ id: 900, current_quantity: 0 }], change), false);
  });
  test('add-ons alone are refused only in Completed Orders', () => {
    const od = (folder_id) => ({ folder_id, shipping_method: 'FedEx Ground', order_items: [{ name: 'Banner' }], shipping: { state: 'GA', country: 'US' } });
    assert.equal(stillAllowed(od(43256), { ...change, ref: 'R' }).allowed, true);    // NJ Awaiting Shipment
    assert.equal(stillAllowed(od(3516), { ...change, ref: 'R' }).allowed, false);    // Completed
  });
  test('the Chat line says what was added and what it cost', () => {
    assert.equal(addOnMessage({ orderName: 'S70001', addOns: [{ product: 'Banner Stands', title: "10'x8' Telescopic Adjustable Stand", quantity: 1 }],
      from: 'FedEx Ground', to: 'FedEx Ground', items: 149, shipping: 9.45, tax: 9.51 }),
    "S70001 added Banner Stands 10'x8' Telescopic Adjustable Stand x1 · shipping +$9.45 · +$149.00 items + $9.51 tax = $167.96");
  });
});
