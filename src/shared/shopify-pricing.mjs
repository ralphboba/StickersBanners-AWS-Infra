// What a shipping change costs, and the tax on it — both from Shopify.
//
// ── why nothing here is computed by us ─────────────────────────────────────
// Checked against the live store on 2026-09-28 (docs/pricing-and-tax.md):
//
//   · PRICE. The FedEx PDF card we used to price from does not match what
//     checkout charges: band edges moved ($96/$96.01, not $98), some prices
//     moved ($44.05 Ground at $447–521, not $43.00), and there are gaps where
//     checkout offers no rate at all ($118.00–$118.10 has no Ground). The only
//     copy that is always right is the store's own, so we ask Shopify for the
//     rates checkout would show at this order's subtotal
//     (draftOrderCalculate → availableShippingRates). No table to drift.
//
//   · TAX. Whether shipping is taxed depends on the state (NJ, TX, FL, PA, NY,
//     GA, TN tax it; MA, VA, NV, AL, MI do not), and some states split it with
//     the items. The charge is therefore sent to Shopify AS A SHIPPING LINE on
//     a draft, beside a $0 taxable placeholder item, so Shopify Tax applies its
//     shipping rules. Reproducing 11 real orders this way matched the tax they
//     were charged in 10 cases to the cent; the 11th (TN) differed by 1¢
//     because Tennessee apportions local tax between items and shipping. The
//     old approach — the charge as a taxable product line — returned $0 tax
//     everywhere, including NJ where the real order paid $1.70.
//
// draftOrderCalculate persists nothing: no draft, no order, no email.
//
// ── refusing is the default ────────────────────────────────────────────────
// A quote is only produced when we can first reproduce, exactly, what the
// customer was charged at checkout. If the rate Shopify gives for their service
// at the checkout subtotal is not the amount on their order — a shipping
// discount, the sticker profile's free 2-day, a rate changed since — we cannot
// say what the difference is, and the page offers nothing. The difference
// itself is priced at the CURRENT subtotal, so an edited order is priced on
// what it is now (Kai).

import { shopifyGraphQL } from './shopify-fetch.mjs';
import { toMailingAddress } from './shopify-orders.mjs';
import { toCents, centsToAmount } from './money.mjs';
import { isPickup } from './order-stage.mjs';
import { stageShippingChange } from './shopify-order-edit.mjs';

const ORDER_FOR_PRICING = `
  query OrderForPricing($q: String!) {
    orders(first: 2, query: $q) {
      nodes {
        id
        name
        taxExempt
        customer { id taxExempt }
        subtotalPriceSet { shopMoney { amount currencyCode } }
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        currentTotalPriceSet { shopMoney { amount } }
        totalOutstandingSet { shopMoney { amount } }
        shippingAddress { address1 address2 city provinceCode zip countryCodeV2 }
        billingAddress { address1 address2 city provinceCode zip countryCodeV2 }
        shippingLines(first: 5) {
          nodes {
            id
            title
            isRemoved
            originalPriceSet { shopMoney { amount } }
            discountedPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

const RATE_CHECK = `
  mutation RateCheck($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder { availableShippingRates { title price { amount currencyCode } } }
      userErrors { field message }
    }
  }
`;

const CHARGE_QUOTE = `
  mutation ChargeQuote($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        currencyCode
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
      }
      userErrors { field message }
    }
  }
`;

const USD = 'USD';
const money = (cents) => ({ amount: centsToAmount(cents), currencyCode: USD });
const addressFrom = (a) => (a ? toMailingAddress({
  address1: a.address1, address2: a.address2, city: a.city,
  provinceCode: a.provinceCode, zip: a.zip, countryCode: a.countryCodeV2,
}) : null);

/**
 * The order as Shopify holds it — what the customer was actually charged.
 * Exact name match, refusing ambiguity, as in fetchOrderByName.
 *
 * @returns {Promise<null | object>}
 */
export async function fetchOrderForPricing({ shop, token, orderName, fetchImpl }) {
  const name = String(orderName ?? '').trim();
  if (!name) return null;
  const payload = await shopifyGraphQL({
    shop, token, fetchImpl, query: ORDER_FOR_PRICING,
    variables: { q: `name:"${name.replace(/"/g, '')}"` },
  });
  const nodes = payload?.data?.orders?.nodes ?? [];
  const exact = nodes.filter((n) => n?.name === name || n?.name === `#${name}`);
  if (exact.length !== 1) return null;
  const o = exact[0];
  const lines = (o.shippingLines?.nodes ?? []).filter((l) => !l.isRemoved);
  return {
    id: o.id,
    name: o.name,
    currentTotalCents: toCents(o.currentTotalPriceSet?.shopMoney?.amount),
    outstandingCents: toCents(o.totalOutstandingSet?.shopMoney?.amount),
    currency: o.subtotalPriceSet?.shopMoney?.currencyCode ?? null,
    subtotalCents: toCents(o.subtotalPriceSet?.shopMoney?.amount),
    currentSubtotalCents: toCents(o.currentSubtotalPriceSet?.shopMoney?.amount),
    orderTaxExempt: Boolean(o.taxExempt),
    customerId: o.customer?.id ?? null,
    customerTaxExempt: Boolean(o.customer?.taxExempt),
    shippingAddress: addressFrom(o.shippingAddress),
    billingAddress: addressFrom(o.billingAddress),
    shippingLines: lines.map((l) => ({
      id: l.id,
      title: l.title,
      originalCents: toCents(l.originalPriceSet?.shopMoney?.amount),
      discountedCents: toCents(l.discountedPriceSet?.shopMoney?.amount),
    })),
  };
}

/**
 * The rates checkout would offer at this subtotal and address, by title.
 * A custom line at the order's subtotal lands in the General profile and is
 * matched against the same price conditions checkout uses.
 *
 * @returns {Promise<Map<string, number> | null>} title -> cents; null if the
 *          answer is unusable (errors, a non-USD price, a title listed twice
 *          at different prices).
 */
export async function checkoutRates({ shop, token, subtotalCents, address, customerId, fetchImpl }) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0 || !address) return null;
  const input = {
    lineItems: [{
      title: 'Rate check',
      originalUnitPriceWithCurrency: money(subtotalCents),
      quantity: 1,
      taxable: true,
      requiresShipping: true,
    }],
    shippingAddress: address,
    ...(customerId ? { purchasingEntity: { customerId } } : {}),
    acceptAutomaticDiscounts: false,
  };
  const payload = await shopifyGraphQL({ shop, token, fetchImpl, query: RATE_CHECK, variables: { input } });
  const result = payload?.data?.draftOrderCalculate;
  if ((result?.userErrors ?? []).length > 0) return null;
  const rates = new Map();
  for (const r of result?.calculatedDraftOrder?.availableShippingRates ?? []) {
    if (r?.price?.currencyCode && r.price.currencyCode !== USD) return null;
    const cents = toCents(r?.price?.amount);
    if (cents === null) return null;
    if (rates.has(r.title) && rates.get(r.title) !== cents) return null;
    rates.set(r.title, cents);
  }
  return rates;
}

/**
 * The draft that carries a shipping charge — used for the quote now and, when
 * invoicing is built, for draftOrderCreate. ONE builder for both, so the
 * invoice cannot be priced differently from the number the customer saw.
 *
 * @param {{ orderName: string, from: string, to: string, amountCents: number,
 *           address: object, customerId?: string|null }} p
 */
export function buildChargeDraftInput({ orderName, from, to, amountCents, address, customerId }) {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('charge must be positive cents');
  if (!address) throw new Error('a charge needs the delivery address');
  return {
    // $0 and taxable: it carries no money itself, but makes the draft a sale of
    // taxable goods, which is what decides whether shipping is taxed in the
    // states that tie the two together.
    lineItems: [{
      title: `Shipping change for order ${orderName}`,
      originalUnitPriceWithCurrency: money(0),
      quantity: 1,
      taxable: true,
      requiresShipping: true,
    }],
    // The charge itself, as shipping — so Shopify Tax treats it as shipping.
    shippingLine: {
      title: `${from} → ${to}`,
      priceWithCurrency: money(amountCents),
    },
    shippingAddress: address,
    ...(customerId ? { purchasingEntity: { customerId } } : {}),
    acceptAutomaticDiscounts: false,
    allowDiscountCodesInCheckout: false,
  };
}

/** Run the charge through Shopify and check the answer adds up. */
async function priceCharge({ shop, token, input, amountCents, fetchImpl }) {
  const payload = await shopifyGraphQL({ shop, token, fetchImpl, query: CHARGE_QUOTE, variables: { input } });
  const result = payload?.data?.draftOrderCalculate;
  if ((result?.userErrors ?? []).length > 0) return { error: 'calc_failed' };
  const c = result?.calculatedDraftOrder;
  const currency = c?.currencyCode ?? c?.subtotalPriceSet?.shopMoney?.currencyCode;
  const subtotal = toCents(c?.subtotalPriceSet?.shopMoney?.amount);
  const shipping = toCents(c?.totalShippingPriceSet?.shopMoney?.amount);
  const tax = toCents(c?.totalTaxSet?.shopMoney?.amount);
  const total = toCents(c?.totalPriceSet?.shopMoney?.amount);
  if ([subtotal, shipping, tax, total].some((v) => v === null)) return { error: 'calc_failed' };
  // Every one of these must hold, or the figure is not one we can stand behind.
  const consistent = currency === USD
    && subtotal === 0
    && shipping === amountCents
    && tax >= 0
    && total === shipping + tax;
  if (!consistent) return { error: 'calc_inconsistent' };
  return { taxCents: tax, totalCents: total };
}

/**
 * Price a change of service on one order: an upgrade (Ground -> 3-Days …) or a
 * pickup converted to delivery.
 *
 * @param {object} p
 * @param {object} p.order      from fetchOrderForPricing
 * @param {string} p.to         the service, exactly as checkout titles it
 * @param {object} [p.deliverTo] the typed address — conversions only
 * @param {string} [p.expectedFrom] the service OrderDesk says the order is on;
 *        if Shopify's line says otherwise, someone has changed it by hand
 * @returns {Promise<{ ok: true, mode: 'upgrade'|'convert', from: string, to: string,
 *                     fromCents: number, toCents: number, shippingCents: number,
 *                     taxCents: number, totalCents: number, draftInput: object }
 *                  | { ok: false, reason: string }>}
 */
export async function quoteShippingChange({ shop, token, order, to, deliverTo, expectedFrom, fetchImpl }) {
  const no = (reason) => ({ ok: false, reason });
  if (!order) return no('order_not_found');
  if (order.currency !== USD) return no('not_usd');
  // An exemption on the order but not the customer was granted by hand for
  // that one order; Shopify would not carry it to a new draft.
  if (order.orderTaxExempt && !order.customerTaxExempt) return no('tax_exempt_order');
  if (order.subtotalCents === null || order.currentSubtotalCents === null) return no('order_unreadable');
  // Two subtotals, two jobs (Kai, 2026-09-28: "new subtotal"):
  //   · checkout's (subtotalPriceSet) proves what the customer paid was the
  //     plain rate — no discount, no hand-set price;
  //   · the current one (after any edit) is what the change is priced on.
  // For an order nobody edited they are the same number and one lookup serves.
  const edited = order.currentSubtotalCents !== order.subtotalCents;

  if (order.shippingLines.length !== 1) return no('shipping_unverified');
  const line = order.shippingLines[0];
  if (line.originalCents === null || line.discountedCents === null) return no('shipping_unverified');
  if (line.discountedCents !== line.originalCents) return no('shipping_discounted');
  if (expectedFrom && line.title !== expectedFrom && !(isPickup(line.title) && isPickup(expectedFrom))) {
    return no('method_changed');
  }

  const mode = isPickup(line.title) ? 'convert' : 'upgrade';
  const address = mode === 'convert' ? toMailingAddress(deliverTo) : order.shippingAddress;
  if (!address) return no('no_address');

  const lookup = (subtotalCents) => checkoutRates({
    shop, token, fetchImpl, subtotalCents, address, customerId: order.customerId,
  });
  const atCheckout = await lookup(order.subtotalCents);
  if (!atCheckout) return no('rates_unavailable');
  const now = edited ? await lookup(order.currentSubtotalCents) : atCheckout;
  if (!now) return no('rates_unavailable');

  let fromCents;
  if (mode === 'convert') {
    // Pickup is free at checkout. If this one was not, something else is going on.
    if (line.originalCents !== 0) return no('price_unverified');
    fromCents = 0;
  } else {
    // THE check: checkout's rate for their service must be what they paid.
    if (atCheckout.get(line.title) !== line.originalCents) return no('price_unverified');
    // The difference is between two full rates at the current subtotal.
    fromCents = now.get(line.title);
    if (fromCents === undefined) return no('service_unavailable');
  }

  const toCentsRate = now.get(to);
  if (toCentsRate === undefined) return no('service_unavailable');
  const shippingCents = toCentsRate - fromCents;
  if (shippingCents <= 0) return no('not_an_upgrade');

  if (mode === 'upgrade') {
    // Priced on the customer's own order (Order Edit): remove the paid line,
    // add the new service, read the balance Shopify would invoice. The new
    // line is priced so the balance's shipping part is exactly shippingCents:
    // what they paid plus the difference of the two rates at the current
    // subtotal (equal to the new rate unless the order was edited).
    if (order.outstandingCents !== 0) return no('balance_due');
    const newLineCents = line.originalCents + shippingCents;
    const edit = await stageShippingChange({
      shop, token, fetchImpl,
      orderId: order.id, removeLineId: line.id, title: to,
      priceCents: newLineCents, totalBeforeCents: order.currentTotalCents,
    });
    if (!edit.ok) return no(edit.reason);
    const taxCents = edit.outstandingCents - shippingCents;
    if (taxCents < 0) return no('calc_inconsistent');
    return {
      ok: true, mode, from: line.title, to,
      pricedAtSubtotalCents: order.currentSubtotalCents,
      fromCents, toCents: toCentsRate, shippingCents,
      taxCents, totalCents: edit.outstandingCents,
      // What commitShippingChange needs to stage the same edit again at the
      // customer's click, and the balance it must still come to.
      edit: { orderId: order.id, removeLineId: line.id, title: to, priceCents: newLineCents,
        expectedOutstandingCents: edit.outstandingCents, calculatedOrderId: edit.calculatedOrderId,
        restore: { title: line.title, priceCents: line.originalCents } },
    };
  }

  // Pickup -> delivery: the tax depends on an address the order does not have
  // yet, so it is priced on a draft at the typed address. (Committing it as an
  // order edit also needs the order's shipping address changed first — not
  // built; see docs/pricing-and-tax.md.)
  const draftInput = buildChargeDraftInput({
    orderName: order.name.replace(/^#/, ''),
    from: line.title, to, amountCents: shippingCents, address, customerId: order.customerId,
  });
  const priced = await priceCharge({ shop, token, fetchImpl, input: draftInput, amountCents: shippingCents });
  if (priced.error) return no(priced.error);

  return {
    ok: true, mode, from: line.title, to,
    pricedAtSubtotalCents: order.currentSubtotalCents,
    fromCents, toCents: toCentsRate, shippingCents,
    taxCents: priced.taxCents, totalCents: priced.totalCents,
    draftInput,
  };
}

/**
 * What a pickup order could be delivered for, before the customer has typed an
 * address: the rate for each service at their current subtotal, BEFORE TAX. Priced at
 * the billing address — every state we deliver to is in the one Domestic zone,
 * so the rate does not depend on which — and never presented as the amount due.
 *
 * @returns {Promise<Array<{ service: string, shippingCents: number }> | null>}
 */
export async function deliveryEstimates({ shop, token, order, services, fetchImpl }) {
  if (!order || order.currency !== USD || order.currentSubtotalCents === null) return null;
  if (!order.billingAddress || order.billingAddress.countryCode !== 'US') return null;
  const rates = await checkoutRates({
    shop, token, fetchImpl, subtotalCents: order.currentSubtotalCents,
    address: order.billingAddress, customerId: order.customerId,
  });
  if (!rates) return null;
  return services
    .filter((s) => rates.has(s))
    .map((s) => ({ service: s, shippingCents: rates.get(s) }));
}
