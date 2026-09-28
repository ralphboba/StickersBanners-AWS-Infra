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
    currentTotalPriceSet: { shopMoney: { amount: '185.61' } },   // 150 + 25.67 + 9.94 tax
    totalOutstandingSet: { shopMoney: { amount: '0.0' } },
    shippingAddress: NJ,
    billingAddress: NJ,
    shippingLines: { nodes: [{
      id: 'gid://shopify/ShippingLine/77',
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
function fakeShopify({ order = shopifyOrder(), rates = RATES_150, tax = () => '0.00', calc, stageOutstanding, stageTotal } = {}) {
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
    if (body.query.includes('EditBegin')) {
      return ok({ orderEditBegin: { userErrors: [], calculatedOrder: {
        id: 'gid://shopify/CalculatedOrder/5',
        shippingLines: order.shippingLines.nodes.map((l) => ({ id: l.id.replace('ShippingLine', 'CalculatedShippingLine'),
          title: l.title, stagedStatus: 'NONE', price: { shopMoney: { amount: l.originalPriceSet.shopMoney.amount } } })),
      } } });
    }
    if (body.query.includes('EditStage')) {
      // Balance = new line − removed line + the tax Shopify charges on it.
      const added = Number(body.variables.add.price.amount);
      const removed = Number(order.shippingLines.nodes[0].originalPriceSet.shopMoney.amount);
      const diff = +(added - removed).toFixed(2);
      const t = Number(tax(diff.toFixed(2)));
      const outstanding = stageOutstanding ?? (diff + t).toFixed(2);
      const before = Number(order.currentTotalPriceSet.shopMoney.amount);
      return ok({
        removed: { userErrors: [] },
        added: { userErrors: [], calculatedOrder: {
          id: 'gid://shopify/CalculatedOrder/5',
          totalPriceSet: { shopMoney: { amount: stageTotal ?? (before + Number(outstanding)).toFixed(2), currencyCode: 'USD' } },
          totalOutstandingSet: { shopMoney: { amount: String(outstanding), currencyCode: 'USD' } },
          shippingLines: [],
        } },
      });
    }
    throw new Error(`unexpected query: ${body.query.slice(0, 60)}`);
  };
  return {
    fetchImpl, sent,
    charge: () => sent.find((b) => b.query.includes('ChargeQuote')),
    stage: () => sent.find((b) => b.query.includes('EditStage')),
  };
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

  test('priced on the customer’s own order: remove the paid line, add the new one', async () => {
    const fake = fakeShopify();
    await quote(fake);
    const v = fake.stage().variables;
    assert.equal(v.remove, 'gid://shopify/CalculatedShippingLine/77');
    assert.deepEqual(v.add, { title: 'FedEx 3-Days', price: { amount: '86.73', currencyCode: 'USD' } });
    assert.equal(fake.charge(), undefined, 'no draft is priced for an upgrade');
  });

  test('rates are asked for at the Shopify subtotal, not OrderDesk’s', async () => {
    const fake = fakeShopify();
    await quote(fake);
    const rc = fake.sent.find((b) => b.query.includes('RateCheck')).variables.input;
    assert.deepEqual(rc.lineItems[0].originalUnitPriceWithCurrency, { amount: '150.00', currencyCode: 'USD' });
    assert.equal(rc.acceptAutomaticDiscounts, false);
  });

  test('the quote carries what the commit needs, and the balance it must come to', async () => {
    const q = await quote(fakeShopify({ tax: () => '4.05' }));
    assert.deepEqual(q.edit, {
      orderId: 'gid://shopify/Order/1', removeLineId: 'gid://shopify/ShippingLine/77',
      title: 'FedEx 3-Days', priceCents: 8673, expectedOutstandingCents: 6511,
    });
  });

  test('the balance is Shopify’s, cent for cent, even when it is not rate × amount', async () => {
    // S64227: 68.17 at 8.9% is 6.07 by multiplication, 6.08 on the order.
    const q = await quote(fakeShopify({ stageOutstanding: '65.12' }));
    assert.equal(q.totalCents, 6512);
    assert.equal(q.taxCents, 6512 - 6106);
  });

  test('an order that already owes money is not stacked on', async () => {
    const order = shopifyOrder({ totalOutstandingSet: { shopMoney: { amount: '10.00' } } });
    assert.equal((await quote(fakeShopify({ order }))).reason, 'balance_due');
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

  test('an edited order is priced on its NEW subtotal', async () => {
    // Paid Ground $25.67 at $150; edited up to $200, where the live rates are
    // Ground $26.20 and 3-Days $92.83. The change is 92.83 − 26.20.
    const order = shopifyOrder({ currentSubtotalPriceSet: { shopMoney: { amount: '200.0', currencyCode: 'USD' } } });
    const RATES_200 = [['FedEx Ground', '26.20'], ['FedEx 3-Days', '92.83'], ['FedEx 2-Days', '139.14'], ['FedEx 1-Day', '192.06']];
    const sent = [];
    const base = fakeShopify({ order });
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes('RateCheck') && body.variables.input.lineItems[0].originalUnitPriceWithCurrency.amount === '200.00') {
        sent.push('200');
        return { ok: true, status: 200, text: async () => '', json: async () => ({ data: { draftOrderCalculate: { userErrors: [],
          calculatedDraftOrder: { availableShippingRates: RATES_200.map(([title, amount]) => ({ title, price: { amount, currencyCode: 'USD' } })) } } } }) };
      }
      return base.fetchImpl(url, init);
    };
    const q = await quote({ fetchImpl });
    assert.equal(q.ok, true);
    assert.deepEqual(sent, ['200'], 'rates asked again at the new subtotal');
    assert.equal(q.pricedAtSubtotalCents, 20000);
    assert.equal(q.fromCents, 2620);
    assert.equal(q.toCents, 9283);
    assert.equal(q.shippingCents, 6663);
  });

  test('an edit does not excuse a paid price that was never the rate', async () => {
    const order = shopifyOrder({ currentSubtotalPriceSet: { shopMoney: { amount: '200.0', currencyCode: 'USD' } } });
    order.shippingLines.nodes[0].originalPriceSet.shopMoney.amount = '10.00';
    order.shippingLines.nodes[0].discountedPriceSet.shopMoney.amount = '10.00';
    assert.equal((await quote(fakeShopify({ order }))).reason, 'price_unverified');
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
    // The edited total must grow by exactly the balance on a fully paid order.
    assert.equal((await quote(fakeShopify({ stageOutstanding: '61.06', stageTotal: '300.00' }))).reason, 'edit_inconsistent');
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
