// The routes behind /my-order. Pure logic: no AWS, no network. The row store
// and the Shopify tax quote are passed in (makeHandler), so what runs in the
// tests is the code that runs in Lambda. See index.mjs for the header comment
// on what this API may and may not say.

import { orderStage, STEPS } from '../../shared/order-stage.mjs';
import { authorisesOrder } from '../../shared/order-token.mjs';
import { centsToDollars } from '../../shared/money.mjs';
import { isNoShipDestination, isPoBox } from '../../shared/upgrade-eligibility.mjs';

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json',
    // The page is one order's private view; nothing about it should be cached
    // by a shared proxy, and the stage changes while the customer is looking.
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

/** One response for "no such order" and "not your order". */
const NOT_FOUND = json(404, { error: 'not_found' });

/** Why the customer cannot upgrade, in words they can act on. */
const BLOCKED_COPY = {
  shipping: 'Your order is with the shipping team, so it can no longer be changed.',
  already_fastest: 'This order is already on our fastest service.',
  service_not_upgradable: 'This order’s shipping cannot be upgraded online.',
  awaiting_routing: 'We’re still scheduling this order. Check back shortly.',
  unknown_folder: 'This order cannot be changed online right now.',
  // Refusals that are about the order itself. Each says enough for the
  // customer to know whether calling would help.
  supplier_order: 'This order is made by one of our partners, so changes go through our team.',
  sticker_order: 'Sticker orders ship on their own schedule, so the shipping can’t be changed online.',
  destination: 'We can’t change shipping for this delivery address.',
  po_box: 'We can’t ship to a PO box.',
  // Production has finished and the order is with the Ground collection.
  ground_after_production: 'Your order is packed and booked on Ground, so the '
    + 'shipping can no longer be changed.',
  // Delivery conversion, address typed by the customer.
  outside_us: 'We can only deliver within the United States.',
};

/**
 * When the order is eligible but we cannot price it exactly (see
 * shopify-pricing.mjs for every reason). The internal reason is logged, never
 * shown: "your shipping was discounted" or "your order was edited" is not
 * something to announce, and the answer for the customer is the same.
 */
const UNPRICEABLE_COPY = 'We can’t price a shipping change for this order online. '
  + 'Contact us and we’ll sort it out.';
const SERVICE_UNAVAILABLE_COPY = 'That service isn’t available for this order online.';

/**
 * Load the row and check the token. Shared by both routes, so the quote route
 * cannot become a way round the access check the status route enforces.
 * @returns {Promise<{ row: object } | { response: object }>}
 */
async function authorised(deps, orderName, presentedUrl) {
  if (!orderName || !presentedUrl) return { response: json(400, { error: 'missing_parameters' }) };

  let row;
  try {
    row = await deps.loadRow(orderName);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'order lookup failed', orderName, err: String(err) }));
    return { response: json(502, { error: 'lookup_failed' }) };
  }
  if (!row) return { response: NOT_FOUND };

  // The token is captured by the mirror. Until it is, no order authorises,
  // which is the correct direction to fail.
  if (!row.orderStatusUrl || !authorisesOrder(presentedUrl, row.orderStatusUrl)) {
    console.warn(JSON.stringify({ msg: 'order status access refused', orderName }));
    return { response: NOT_FOUND };
  }
  return { row };
}

function stageFor(row) {
  return orderStage({
    folderId: row.folderId,
    shippingMethod: row.shipping?.method ?? null,
    shipping: row.shipping,
    items: row.items,
  });
}

/**
 * Build the handler around what leaves the process: the row store and
 * Shopify. index.mjs supplies the real ones; the tests supply fakes, which is
 * why this file imports nothing from AWS.
 *
 * @param {{ loadRow: (orderName: string) => Promise<object|undefined>,
 *           loadShopifyOrder: (orderName: string) => Promise<object|null>,
 *           quote: (p: object) => Promise<object>,
 *           estimates: (p: object) => Promise<Array<object>|null> }} deps
 *   quote / estimates are shopify-pricing's quoteShippingChange and
 *   deliveryEstimates with the credentials already bound.
 */
export function makeHandler(deps) {
  const authorisedFor = (orderName, url) => authorised(deps, orderName, url);
  return async function handler(event = {}) {
    const method = String(event?.requestContext?.http?.method ?? event?.httpMethod ?? 'GET').toUpperCase();
    if (method === 'POST') return quoteDelivery(deps, authorisedFor, event);
    return status(deps, authorisedFor, event);
  };
}

function logRefusal(orderName, reason) {
  console.log(JSON.stringify({ msg: 'shipping change not priced', orderName, reason }));
}

// ── GET /my-order ──────────────────────────────────────────────────────────
async function status(deps, authorised, event) {
  const q = event?.queryStringParameters ?? {};
  const orderName = String(q.o ?? '').trim();
  const got = await authorised(orderName, String(q.s ?? '').trim());
  if (got.response) return got.response;
  const { row } = got;

  const currentMethod = row.shipping?.method ?? null;
  const stage = stageFor(row);

  // ── the upgrade quote ─────────────────────────────────────────────────
  // Price AND tax both come from Shopify (shopify-pricing.mjs). A quote exists
  // only when today's checkout rate for the customer's current service is
  // exactly what they paid; otherwise the difference is not knowable and the
  // page offers nothing rather than a number we might have to refund.
  let upgrade = null;
  let refusal = null;
  const shopifyOrder = (stage.canUpgrade || stage.canConvert)
    ? await deps.loadShopifyOrder(orderName)
    : null;

  if (stage.canUpgrade) {
    const q = await deps.quote({ order: shopifyOrder, to: stage.upgradeTo, expectedFrom: currentMethod });
    if (q.ok) {
      upgrade = {
        to: q.to,
        shipping: centsToDollars(q.shippingCents),
        tax: centsToDollars(q.taxCents),
        total: centsToDollars(q.totalCents),
        final: true,
        currentPrice: centsToDollars(q.fromCents),
        newPrice: centsToDollars(q.toCents),
      };
    } else {
      logRefusal(orderName, q.reason);
      refusal = q.reason === 'service_unavailable' ? SERVICE_UNAVAILABLE_COPY : UNPRICEABLE_COPY;
    }
  }

  // ── the delivery conversion ───────────────────────────────────────────
  // No delivery address yet, so no tax yet. Each option shows the rate
  // checkout would charge, marked "plus tax"; the amount due is produced by
  // POST once the customer has typed an address. A rate we could not fetch is
  // shown as a name without a price, never as a guess.
  let delivery = null;
  if (stage.canConvert) {
    const est = await deps.estimates({ order: shopifyOrder, services: stage.convertTo });
    const byService = new Map((est ?? []).map((e) => [e.service, e.shippingCents]));
    const options = stage.convertTo
      // With estimates, list only what checkout actually offers at this
      // subtotal; without them, list the services and price them at quote time.
      .filter((service) => !est || byService.has(service))
      .map((service) => ({
        service,
        shipping: byService.has(service) ? centsToDollars(byService.get(service)) : null,
      }));
    if (options.length) delivery = { options, needsAddress: true, final: false };
  }

  const offering = Boolean(upgrade || delivery);
  return json(200, {
    orderName: row.orderName,
    stage: { label: stage.label, step: stage.step, steps: STEPS },
    shipping: {
      current: stage.currentService ?? currentMethod,
      canUpgrade: Boolean(upgrade),
      canConvert: Boolean(delivery),
      reason: offering ? null
        : (refusal ?? BLOCKED_COPY[stage.blockedBy] ?? BLOCKED_COPY.unknown_folder),
      upgrade,
      delivery,
    },
    addOns: [], // pending the item and price list
  });
}

// ── POST /my-order/quote ───────────────────────────────────────────────────
// Prices a pickup-to-delivery conversion for one service and one address.
// READ ONLY like everything else in this function: draftOrderCalculate prices
// a draft without creating it, and nothing is written anywhere.
const ADDRESS_FIELDS = ['address1', 'address2', 'city', 'province', 'zip', 'country'];

async function quoteDelivery(deps, authorised, event) {
  let body;
  try {
    body = JSON.parse(event?.body ?? '{}');
  } catch {
    return json(400, { error: 'bad_json' });
  }
  const orderName = String(body.o ?? '').trim();
  const got = await authorised(orderName, String(body.s ?? '').trim());
  if (got.response) return got.response;
  const { row } = got;

  // Re-decide from the current row rather than trusting what the page showed:
  // the warehouse may have moved the order since the page was opened.
  const stage = stageFor(row);
  if (!stage.canConvert) {
    return json(409, { error: 'not_convertible', reason: BLOCKED_COPY[stage.blockedBy] ?? null });
  }

  const service = String(body.service ?? '');
  if (!stage.convertTo.includes(service)) return json(400, { error: 'service_not_offered' });

  const a = body.address ?? {};
  const address = Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, String(a[k] ?? '').trim()]));
  address.province = address.province.toUpperCase();
  address.country = (address.country || 'US').toUpperCase();
  if (!address.address1 || !address.city || !/^[A-Z]{2}$/.test(address.province) || !address.zip) {
    return json(400, { error: 'address_incomplete' });
  }
  // The store's rates cover one Domestic (US) zone. Nothing else has a price.
  if (address.country !== 'US') {
    return json(422, { error: 'outside_us', reason: BLOCKED_COPY.outside_us });
  }

  // The destination rules that could not be judged on a pickup order can be
  // judged now. Same rules, same wording, as for an order already shipping.
  if (isNoShipDestination({ state: address.province, country: address.country })) {
    return json(422, { error: 'destination', reason: BLOCKED_COPY.destination });
  }
  if (isPoBox(address.address1, address.address2)) {
    return json(422, { error: 'po_box', reason: BLOCKED_COPY.po_box });
  }

  const order = await deps.loadShopifyOrder(orderName);
  const q = await deps.quote({
    order, to: service, expectedFrom: row.shipping?.method ?? null,
    // The typed address REPLACES the order's: tax is owed where it is delivered.
    deliverTo: address,
  });
  if (!q.ok) {
    logRefusal(orderName, q.reason);
    return json(422, {
      error: q.reason === 'service_unavailable' ? 'service_unavailable' : 'unpriceable',
      reason: q.reason === 'service_unavailable' ? SERVICE_UNAVAILABLE_COPY : UNPRICEABLE_COPY,
    });
  }

  return json(200, {
    service,
    shipping: centsToDollars(q.shippingCents),
    tax: centsToDollars(q.taxCents),
    total: centsToDollars(q.totalCents),
    final: true,
  });
}
