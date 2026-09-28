// Pricing a shipping change. The fake Shopify below answers with figures the
// live store gave on 2026-09-28 (docs/pricing-and-tax.md), so these tests pin
// the behaviour to what checkout actually does.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchOrderForPricing, checkoutRates, buildChargeDraftInput,
  quoteShippingChange, deliveryEstimates,
} from '../../src/shared/shopify-pricing.mjs';
import { __resetShopifyClient, checkReadOnly } from '../../src/shared/shopify-fetch.mjs';

beforeEach(() => { __resetShopifyClient(); });

const ARGS = { shop: 's.myshopify.com', token: 't' };
const NJ = { address1: '115 Powelton Avenue', city: 'Oaklyn', provinceCode: 'NJ', zip: '08107', countryCodeV2: 'US' };

// Live rates at a $150 subtotal (RateCheck probe, 2026-09-28).
const RATES_150 = [
  ['FedEx Ground', '25.67'], ['FedEx 3-Days', '86.73'], ['FedEx 2-Days', '128.11'],
  ['FedEx 1-Day', '162.07'], ['FedEx Overnight (Saturday)', '195.14'],
];

function shopifyOrder(over = {}) {
  return {
    id: 'gid://shopify/Order/1',
    name: 'S64201',
    taxExempt: false,
    customer: { id: 'gid://shopify/Customer/9', taxExempt: false },
    subtotalPriceSet: { shopMoney: { amount: '150.0', currencyCode: 'USD' } },
    currentSubtotalPriceSet: { shopMoney: { amount: '150.0', currencyCode: 'USD' } },
    shippingAddress: NJ,
    billingAddress: NJ,
    shippingLines: { nodes: [{
      title: 'FedEx Ground', isRemoved: false,
      originalPriceSet: { shopMoney: { amount: '25.67' } },
      discountedPriceSet: { shopMoney: { amount: '25.67' } },
    }] },
    ...over,
  };
}

/**
 * A fake Shopify. Routes by operation name, records every request, and prices
 * the charge with the tax function you give it.
 */
function fakeShopify({ order = shopifyOrder(), rates = RATES_150, tax = () => '0.00', calc } = {}) {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const ok = (data) => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ data, extensions: { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } } }),
    });
    if (body.query.includes('OrderForPricing')) return ok({ orders: { nodes: order ? [order] : [] } });
    if (body.query.includes('RateCheck')) {
      return ok({ draftOrderCalculate: { userErrors: [], calculatedDraftOrder: {
        availableShippingRates: rates.map(([title, amount]) => ({ title, price: { amount, currencyCode: 'USD' } })),
      } } });
    }
    if (body.query.includes('ChargeQuote')) {
      const ship = body.variables.input.shippingLine.priceWithCurrency.amount;
      const t = tax(ship);
      const c = calc ?? {
        currencyCode: 'USD',
        subtotalPriceSet: { shopMoney: { amount: '0.0', currencyCode: 'USD' } },
        totalShippingPriceSet: { shopMoney: { amount: ship } },
        totalTaxSet: { shopMoney: { amount: t } },
        totalPriceSet: { shopMoney: { amount: (Number(ship) + Number(t)).toFixed(2) } },
      };
      return ok({ draftOrderCalculate: { userErrors: [], calculatedDraftOrder: c } });
    }
    throw new Error(`unexpected query: ${body.query.slice(0, 60)}`);
  };
  return { fetchImpl, sent, charge: () => sent.find((b) => b.query.includes('ChargeQuote')) };
}

async function quote(fake, extra = {}) {
  const order = await fetchOrderForPricing({ ...ARGS, orderName: 'S64201', fetchImpl: fake.fetchImpl });
  return quoteShippingChange({ ...ARGS, order, to: 'FedEx 3-Days', fetchImpl: fake.fetchImpl, ...extra });
}

describe('an upgrade priced from the live store', () => {
  test('difference of checkout rates, tax from Shopify, all in cents', async () => {
    // NJ taxes shipping at 6.625%: 61.06 * 0.06625 = 4.045 -> Shopify says 4.05.
    const fake = fakeShopify({ tax: () => '4.05' });
    const q = await quote(fake);
    assert.equal(q.ok, true);
    assert.equal(q.mode, 'upgrade');
    assert.equal(q.fromCents, 2567);
    assert.equal(q.toCents, 8673);
    assert.equal(q.shippingCents, 6106);
    assert.equal(q.taxCents, 405);
    assert.equal(q.totalCents, 6511);
  });

  test('the charge goes to Shopify as SHIPPING, beside a $0 taxable item', async () => {
    const fake = fakeShopify();
    await quote(fake);
    const input = fake.charge().variables.input;
    assert.deepEqual(input.shippingLine.priceWithCurrency, { amount: '61.06', currencyCode: 'USD' });
    assert.equal(input.shippingLine.title, 'FedEx Ground → FedEx 3-Days');
    assert.equal(input.lineItems.length, 1);
    assert.deepEqual(input.lineItems[0].originalUnitPriceWithCurrency, { amount: '0.00', currencyCode: 'USD' });
    assert.equal(input.lineItems[0].taxable, true);
    assert.equal(input.lineItems[0].requiresShipping, true);
    assert.equal(input.acceptAutomaticDiscounts, false, 'a store discount must not eat the charge');
    assert.equal(input.purchasingEntity.customerId, 'gid://shopify/Customer/9', 'so exemptions apply');
    assert.equal(input.shippingAddress.provinceCode, 'NJ');
  });

  test('rates are asked for at the Shopify subtotal, not OrderDesk’s', async () => {
    const fake = fakeShopify();
    await quote(fake);
    const rc = fake.sent.find((b) => b.query.includes('RateCheck')).variables.input;
    assert.deepEqual(rc.lineItems[0].originalUnitPriceWithCurrency, { amount: '150.00', currencyCode: 'USD' });
    assert.equal(rc.acceptAutomaticDiscounts, false);
  });

  test('the quote carries the draft input, for the invoice to reuse unchanged', async () => {
    const fake = fakeShopify();
    const q = await quote(fake);
    assert.deepEqual(q.draftInput, fake.charge().variables.input);
  });

  test('every request it sends passes the read-only guard', async () => {
    const fake = fakeShopify();
    await quote(fake);
    for (const b of fake.sent) assert.equal(checkReadOnly(b.query).ok, true);
  });
});

describe('refuses whenever it cannot reproduce what the customer paid', () => {
  test('paid price differs from today’s checkout rate', async () => {
    const order = shopifyOrder();
    order.shippingLines.nodes[0].originalPriceSet.shopMoney.amount = '27.25';   // the PDF card's figure
    order.shippingLines.nodes[0].discountedPriceSet.shopMoney.amount = '27.25';
    assert.equal((await quote(fakeShopify({ order }))).reason, 'price_unverified');
  });

  test('the sticker profile’s free "FedEx 2-days"', async () => {
    const order = shopifyOrder();
    order.shippingLines.nodes[0] = { title: 'FedEx 2-days', isRemoved: false,
      originalPriceSet: { shopMoney: { amount: '0.0' } }, discountedPriceSet: { shopMoney: { amount: '0.0' } } };
    const q = await quote(fakeShopify({ order }), { to: 'FedEx 1-Day' });
    assert.equal(q.ok, false);
    assert.equal(q.reason, 'price_unverified');
  });

  test('shipping was discounted', async () => {
    const order = shopifyOrder();
    order.shippingLines.nodes[0].discountedPriceSet.shopMoney.amount = '0.0';
    assert.equal((await quote(fakeShopify({ order }))).reason, 'shipping_discounted');
  });

  test('the order was edited after checkout', async () => {
    const order = shopifyOrder({ currentSubtotalPriceSet: { shopMoney: { amount: '180.0', currencyCode: 'USD' } } });
    assert.equal((await quote(fakeShopify({ order }))).reason, 'order_edited');
  });

  test('OrderDesk says a different service than Shopify charged for', async () => {
    const q = await quote(fakeShopify(), { expectedFrom: 'FedEx 2-Days' });
    assert.equal(q.reason, 'method_changed');
  });

  test('checkout does not offer the target at this subtotal (a gap)', async () => {
    // At $118.05 the live store offers no Ground; here, no 3-Days.
    const rates = RATES_150.filter(([t]) => t !== 'FedEx 3-Days');
    assert.equal((await quote(fakeShopify({ rates }))).reason, 'service_unavailable');
  });

  test('a rate listed twice at different prices', async () => {
    const rates = [...RATES_150, ['FedEx 3-Days', '90.00']];
    assert.equal((await quote(fakeShopify({ rates }))).reason, 'rates_unavailable');
  });

  test('a manual exemption on the order only', async () => {
    const order = shopifyOrder({ taxExempt: true });
    assert.equal((await quote(fakeShopify({ order }))).reason, 'tax_exempt_order');
  });

  test('not dollars', async () => {
    const order = shopifyOrder({ subtotalPriceSet: { shopMoney: { amount: '150.0', currencyCode: 'CAD' } } });
    assert.equal((await quote(fakeShopify({ order }))).reason, 'not_usd');
  });

  test('Shopify’s answer does not add up', async () => {
    const calc = {
      currencyCode: 'USD',
      subtotalPriceSet: { shopMoney: { amount: '0.0', currencyCode: 'USD' } },
      totalShippingPriceSet: { shopMoney: { amount: '0.0' } },   // a discount ate it
      totalTaxSet: { shopMoney: { amount: '0.0' } },
      totalPriceSet: { shopMoney: { amount: '0.0' } },
    };
    assert.equal((await quote(fakeShopify({ calc }))).reason, 'calc_inconsistent');
  });

  test('a downgrade or no change is not sold', async () => {
    const q = await quote(fakeShopify(), { to: 'FedEx Ground' });
    assert.equal(q.reason, 'not_an_upgrade');
  });

  test('no order at all', async () => {
    const fake = fakeShopify({ order: null });
    const order = await fetchOrderForPricing({ ...ARGS, orderName: 'S64201', fetchImpl: fake.fetchImpl });
    assert.equal(order, null);
    assert.equal((await quoteShippingChange({ ...ARGS, order, to: 'FedEx 3-Days', fetchImpl: fake.fetchImpl })).reason,
      'order_not_found');
  });

  test('nothing is sent to be taxed once a refusal is known', async () => {
    const order = shopifyOrder();
    order.shippingLines.nodes[0].discountedPriceSet.shopMoney.amount = '0.0';
    const fake = fakeShopify({ order });
    await quote(fake);
    assert.equal(fake.charge(), undefined);
  });
});

describe('pickup converted to delivery', () => {
  const pickupOrder = () => {
    const o = shopifyOrder({ shippingAddress: null });
    o.shippingLines.nodes[0] = { title: 'Georgia Warehouse', isRemoved: false,
      originalPriceSet: { shopMoney: { amount: '0.0' } }, discountedPriceSet: { shopMoney: { amount: '0.0' } } };
    return o;
  };
  const TYPED = { address1: '1 Peachtree St', city: 'Atlanta', province: 'GA', zip: '30303', country: 'US' };

  test('full rate, taxed at the typed address', async () => {
    const fake = fakeShopify({ order: pickupOrder(), tax: () => '7.69' });
    const q = await quote(fake, { to: 'FedEx 2-Days', deliverTo: TYPED, expectedFrom: 'Georgia Warehouse' });
    assert.equal(q.ok, true);
    assert.equal(q.mode, 'convert');
    assert.equal(q.fromCents, 0);
    assert.equal(q.shippingCents, 12811);
    assert.equal(q.totalCents, 12811 + 769);
    assert.equal(fake.charge().variables.input.shippingAddress.zip, '30303');
    assert.equal(fake.charge().variables.input.shippingLine.title, 'Georgia Warehouse → FedEx 2-Days');
  });

  test('no typed address, no quote', async () => {
    const q = await quote(fakeShopify({ order: pickupOrder() }), { to: 'FedEx 2-Days' });
    assert.equal(q.reason, 'no_address');
  });

  test('a pickup that was charged for is not a pickup we understand', async () => {
    const o = pickupOrder();
    o.shippingLines.nodes[0].originalPriceSet.shopMoney.amount = '5.0';
    o.shippingLines.nodes[0].discountedPriceSet.shopMoney.amount = '5.0';
    const q = await quote(fakeShopify({ order: o }), { to: 'FedEx 2-Days', deliverTo: TYPED });
    assert.equal(q.reason, 'price_unverified');
  });

  test('estimates list what checkout offers, before tax', async () => {
    const fake = fakeShopify({ order: pickupOrder() });
    const order = await fetchOrderForPricing({ ...ARGS, orderName: 'S64201', fetchImpl: fake.fetchImpl });
    const est = await deliveryEstimates({ ...ARGS, order, fetchImpl: fake.fetchImpl,
      services: ['FedEx Ground', 'FedEx 3-Days', 'FedEx 2-Days', 'FedEx 1-Day'] });
    assert.deepEqual(est, [
      { service: 'FedEx Ground', shippingCents: 2567 },
      { service: 'FedEx 3-Days', shippingCents: 8673 },
      { service: 'FedEx 2-Days', shippingCents: 12811 },
      { service: 'FedEx 1-Day', shippingCents: 16207 },
    ]);
    assert.equal(fake.charge(), undefined, 'estimates never ask for tax');
  });
});

describe('buildChargeDraftInput', () => {
  const base = { orderName: 'S1', from: 'FedEx Ground', to: 'FedEx 3-Days', address: { provinceCode: 'GA', zip: '30301', countryCode: 'US' } };
  test('refuses a charge that is not positive whole cents', () => {
    for (const amountCents of [0, -1, 1.5, NaN]) {
      assert.throws(() => buildChargeDraftInput({ ...base, amountCents }), String(amountCents));
    }
  });
  test('refuses a charge with nowhere to tax it', () => {
    assert.throws(() => buildChargeDraftInput({ ...base, amountCents: 100, address: null }));
  });
});

describe('checkoutRates', () => {
  test('no address or a bad subtotal never reaches Shopify', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; };
    assert.equal(await checkoutRates({ ...ARGS, fetchImpl, subtotalCents: 15000, address: null }), null);
    assert.equal(await checkoutRates({ ...ARGS, fetchImpl, subtotalCents: 1.5, address: {} }), null);
    assert.equal(called, false);
  });
});
