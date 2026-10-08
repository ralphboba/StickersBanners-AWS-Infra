// The routes behind /my-order. Pure logic: no AWS, no network. The row store
// and the Shopify tax quote are passed in (makeHandler), so what runs in the
// tests is the code that runs in Lambda. See index.mjs for the header comment
// on what this API may and may not say.

import { orderStage, STEPS } from '../../shared/order-stage.mjs';
import { authorisesOrder } from '../../shared/order-token.mjs';
import { centsToDollars, toCents } from '../../shared/money.mjs';
import { isNoShipDestination, isPoBox } from '../../shared/upgrade-eligibility.mjs';
import { orderBeforeChange } from '../../shared/shopify-pricing.mjs';
import { resolveAddOns } from '../../shared/addon-catalog.mjs';

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

/** Every "no options" message ends by pointing to the team (Kai, 2026-10-08). */
const ASK_TEAM = ' If you have any questions, please contact our team.';

/** Why the customer cannot upgrade, in words they can act on. */
const BLOCKED_COPY = Object.fromEntries(Object.entries({
  // Completed Orders (Kai, 2026-10-08: "your order has been shipped, on the way").
  shipping: 'Your order has been shipped and is on its way to your address.',
  // A pickup order in Completed Orders: nothing is on its way, it was collected.
  completed_pickup: 'Your order has been completed.',
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
  address_incomplete: 'Please fill in the street, city, state and ZIP code.',
}).map(([k, v]) => [k, v + ASK_TEAM]));

/**
 * When the order is eligible but we cannot price it exactly (see
 * shopify-pricing.mjs for every reason). Each reason has its own words (Kai,
 * 2026-10-08: "경우마다 다르게 표시" — one message for every case confused
 * customers), so the customer can tell whether to wait, retry, pay first or
 * contact us. Anything not listed falls back to UNPRICEABLE_COPY.
 */
const UNPRICEABLE_COPY = 'We can’t price a shipping change for this order online. '
  + 'Contact us and we’ll sort it out.';
const SERVICE_UNAVAILABLE_COPY = 'Faster shipping isn’t available for this order’s delivery address.';
const REFUSAL_COPY = {
  shipping_discounted: 'Your order got a shipping discount, so a change can’t be priced online. '
    + 'Contact us and we’ll update it for you.',
  method_changed: 'Our team has already changed the shipping on this order. '
    + 'Contact us if you’d like to change it again.',
  switch_line_mismatch: 'Our team has already changed the shipping on this order. '
    + 'Contact us if you’d like to change it again.',
  price_unverified: 'Shipping rates have changed since you placed this order, so we can’t work out '
    + 'the difference online. Contact us and we’ll take care of it.',
  balance_due: 'This order still has a balance to pay. Once it’s paid, you can change the shipping here.',
  tax_exempt_order: 'This order has a tax exemption we can’t apply online. '
    + 'Contact us to change the shipping.',
  not_usd: 'Orders paid in another currency can’t be changed online. Contact us to change the shipping.',
  shipping_unverified: 'This order has more than one shipping charge, so it can’t be changed online. '
    + 'Contact us and we’ll update it.',
  no_address: 'We don’t have a delivery address on this order. Contact us to change the shipping.',
  not_an_upgrade: 'There’s no faster shipping to offer for this order.',
  service_unavailable: SERVICE_UNAVAILABLE_COPY,
  rates_unavailable: 'We couldn’t get shipping prices right now. Please try again in a few minutes.',
  order_not_found: 'We couldn’t load your order’s details right now. Please try again in a few minutes.',
  order_unreadable: 'We couldn’t load your order’s details right now. Please try again in a few minutes.',
  // Shopify would not open an edit on this order (e.g. how it was paid).
  edit_begin_failed: 'This order can’t be edited online because of how it was paid. '
    + 'Contact us and we’ll change the shipping for you.',
};
const refusalCopy = (reason) => REFUSAL_COPY[reason] ?? UNPRICEABLE_COPY;
/** Shipping changes are switched off (deploy without shippingChange=live). */
const NOT_AVAILABLE_COPY = 'Changes to your order aren’t available online right now. Please try again later or contact us.';
/** A change already flagged for the team (attention). */
const WITH_TEAM_COPY = 'Our team is reviewing a shipping change on this order and will contact you.';

/**
 * Load the row and check the token. Shared by both routes, so the quote route
 * cannot become a way round the access check the status route enforces.
 * @returns {Promise<{ row: object } | { response: object }>}
 */
async function authorised(deps, orderName, presentedUrl) {
  if (!orderName || !presentedUrl) return { response: json(400, { error: 'missing_parameters' }) };

  let row;
  try {
    row = await deps.loadRow(orderName, presentedUrl);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'order lookup failed', orderName, err: String(err) }));
    return { response: json(502, { error: 'lookup_failed', reason: 'We couldn’t load your order right now. Please try again in a few minutes.' }) };
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
 * @param {{ loadRow: (orderName: string, presentedUrl?: string) => Promise<object|undefined>,
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
    const path = String(event?.rawPath ?? event?.requestContext?.http?.path ?? event?.path ?? '');
    if (method === 'POST' && path.endsWith('/request')) return requestChange(deps, authorisedFor, event);
    if (method === 'POST' && wantsAddOns(event)) return quoteAddOns(deps, authorisedFor, event);
    if (method === 'POST') return quoteDelivery(deps, authorisedFor, event);
    return status(deps, authorisedFor, event);
  };
}

// Where the customer's wait goes: ms since the request started, per step.
function timer(route, orderName) {
  const t0 = Date.now();
  const marks = {};
  return {
    mark: (k) => { marks[k] = Date.now() - t0; },
    done: (k = 'total') => { marks[k] = Date.now() - t0; console.log(JSON.stringify({ msg: 'timing', route, orderName, ...marks })); },
  };
}

function logRefusal(orderName, reason) {
  console.log(JSON.stringify({ msg: 'shipping change not priced', orderName, reason }));
}

// Every faster service, each priced by Shopify on its own staged edit. The
// options are priced at the same time and share one rate lookup — one by one
// they took ~9 Shopify calls in a row. Results are read in order: a refusal
// about the ORDER (price not verifiable, balance due, …) applies to every
// option and ends the list there; "service not sold at this subtotal" is per
// option.
async function quoteUpgrades(deps, orderName, options, order, expectedFrom) {
  const upgrades = [];
  let refusal = null;
  const rateCache = new Map();
  const results = await Promise.all(options.map((to) => deps.quote({ order, to, expectedFrom, rateCache })));
  for (const q of results) {
    if (q.ok) {
      upgrades.push({
        to: q.to,
        shipping: centsToDollars(q.shippingCents),
        tax: centsToDollars(q.taxCents),
        total: centsToDollars(q.totalCents),
        final: true,
        currentPrice: centsToDollars(q.fromCents),
        newPrice: centsToDollars(q.toCents),
      });
      continue;
    }
    logRefusal(orderName, q.reason);
    if (q.reason !== 'service_unavailable') { refusal = refusalCopy(q.reason); break; }
    refusal = refusal ?? SERVICE_UNAVAILABLE_COPY;
  }
  return { upgrades, refusal };
}

// The services a customer may move to: faster ones for a shipped order, all
// four for a pickup (delivered to the address on the order). One list, one
// screen, one way to pay.
function offeredServices(stage) {
  if (stage.canUpgrade) return stage.upgradeOptions ?? [stage.upgradeTo];
  if (stage.canConvert) return stage.convertTo ?? [];
  return [];
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

  // ── the quick view (?lite=1) ───────────────────────────────────────────
  // No Shopify call: the order, its progress and the names of the faster
  // services, so the page shows something at once while the priced view
  // (below, a few seconds of Shopify) is on its way. Nothing here is more
  // than the full view already says.
  if (q.lite === '1') {
    return json(200, {
      orderName: row.orderName,
      stage: { label: stage.label, step: stage.step, steps: STEPS },
      shipping: {
        current: stage.currentService ?? currentMethod,
        lite: true,
        // Pickup orders are priced only once the address is entered.
        optionNames: stage.canUpgrade ? offeredServices(stage) : [],
      },
      addOns: [],
    });
  }

  const t = timer('GET', orderName);

  // ── an upgrade already chosen and waiting for payment ─────────────────
  // The customer clicked, the order was edited, they have not paid yet (closed
  // the payment page, or came back from the email). They can still pay for
  // it — or pick a different speed (Kai: "옵션 고를 수 있게 해야된다니까"), so
  // every option is priced again from the order as it was before the change.
  const pending = deps.loadPending ? await deps.loadPending(orderName) : null;
  if (pending?.status === 'pending') {
    const order = await deps.loadShopifyOrder(orderName);
    t.mark('shopifyOrder');
    const paymentUrl = pending.paymentUrl ?? order?.paymentUrl ?? null;
    if (paymentUrl && order?.outstandingCents > 0) {
      const before = offeredServices(stage).length ? orderBeforeChange(order, pending) : null;
      const { upgrades } = !before ? { upgrades: [] }
        : pending.addOns?.length
          ? await quoteUpgradesDroppingAddOns(deps, orderName, offeredServices(stage), before, pending)
          : await quoteUpgrades(deps, orderName, offeredServices(stage), before, pending.from);
      if (!upgrades.length) {
        // Options could not be re-priced: say why in the log (no secrets).
        console.warn(JSON.stringify({ msg: 'pending options not repriced', orderName, canUpgrade: stage.canUpgrade,
          blockedBy: stage.blockedBy ?? null, before: Boolean(before), shopifyLine: order.shippingLines?.[0]?.title ?? null,
          pendingTo: pending.to, hasRestore: Boolean(pending.restore), outstandingCents: order.outstandingCents }));
      }
      t.done();
      return json(200, {
        orderName: row.orderName,
        stage: { label: stage.label, step: stage.step, steps: STEPS },
        shipping: {
          current: pending.from, canUpgrade: upgrades.length > 0, canConvert: false, reason: null,
          pickup: stage.canConvert === true,
          upgrades, upgrade: upgrades[0] ?? null,
          awaitingPayment: { from: pending.from, to: pending.to, total: centsToDollars(order.outstandingCents), paymentUrl,
            ...(pending.addOns?.length ? { addOns: pending.addOns.map(publicItem) } : {}) },
        },
        addOns: await addOnList(deps, stage),
      });
    }
  }

  // ── the upgrade quote ─────────────────────────────────────────────────
  // Price AND tax both come from Shopify (shopify-pricing.mjs). A quote exists
  // only when today's checkout rate for the customer's current service is
  // exactly what they paid; otherwise the difference is not knowable and the
  // page offers nothing rather than a number we might have to refund.
  let upgrade = null;
  let refusal = null;
  const shopifyOrder = stage.canUpgrade ? await deps.loadShopifyOrder(orderName) : null;

  // A shipped order: every faster service, priced now. A pickup order: the
  // customer enters the delivery address first and THEN sees the services
  // priced for it, the way checkout does (Kai, 2026-10-05) — nothing is priced
  // before there is an address (POST /my-order/quote).
  const upgrades = [];
  const services = stage.canUpgrade ? offeredServices(stage) : [];
  if (services.length) {
    t.mark('shopifyOrder');
    const priced = await quoteUpgrades(deps, orderName, services, shopifyOrder, currentMethod);
    t.mark('quotes');
    upgrades.push(...priced.upgrades);
    refusal = priced.refusal;
    upgrade = upgrades[0] ?? null;
    if (upgrade) refusal = null;
  }
  const delivery = stage.canConvert ? { needsAddress: true, options: stage.convertTo.map((service) => ({ service })) } : null;

  const offering = Boolean(upgrade || delivery);
  t.done();
  return json(200, {
    orderName: row.orderName,
    stage: { label: stage.label, step: stage.step, steps: STEPS },
    shipping: {
      current: stage.currentService ?? currentMethod,
      canUpgrade: Boolean(upgrade),
      upgrades,
      canConvert: Boolean(delivery),
      reason: offering ? null
        : (refusal ?? BLOCKED_COPY[stage.blockedBy] ?? BLOCKED_COPY.unknown_folder),
      upgrade,
      delivery,
      pickup: stage.canConvert === true,
      needsAddress: Boolean(delivery),
    },
    addOns: await addOnList(deps, stage),
  });
}

// ── POST /my-order/quote ───────────────────────────────────────────────────
// Prices a pickup-to-delivery conversion for one service and one address.
// READ ONLY like everything else in this function: draftOrderCalculate prices
// a draft without creating it, and nothing is written anywhere.
const ADDRESS_FIELDS = ['address1', 'address2', 'city', 'province', 'zip', 'country'];

// The delivery address a pickup customer typed: complete, US, not a PO box,
// not a place the store does not ship to. Same rules and wording as for an
// order already shipping.
function checkDeliveryAddress(raw) {
  const a = raw ?? {};
  const address = Object.fromEntries(ADDRESS_FIELDS.map((k) => [k, String(a[k] ?? '').trim()]));
  address.province = address.province.toUpperCase();
  address.country = (address.country || 'US').toUpperCase();
  if (!address.address1 || !address.city || !/^[A-Z]{2}$/.test(address.province) || !address.zip) {
    return { response: json(400, { error: 'address_incomplete', reason: BLOCKED_COPY.address_incomplete }) };
  }
  // The store's rates cover one Domestic (US) zone. Nothing else has a price.
  if (address.country !== 'US') return { response: json(422, { error: 'outside_us', reason: BLOCKED_COPY.outside_us }) };
  if (isNoShipDestination({ state: address.province, country: address.country })) {
    return { response: json(422, { error: 'destination', reason: BLOCKED_COPY.destination }) };
  }
  if (isPoBox(address.address1, address.address2)) return { response: json(422, { error: 'po_box', reason: BLOCKED_COPY.po_box }) };
  return { address };
}

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

  const service = body.service === undefined ? null : String(body.service);
  if (service !== null && !stage.convertTo.includes(service)) return json(400, { error: 'service_not_offered' });

  const checked = checkDeliveryAddress(body.address);
  if (checked.response) return checked.response;
  const { address } = checked;

  // No service named: every delivery service, priced at this address with
  // Shopify's tax — what checkout would have shown (Kai, 2026-10-05).
  if (service === null) {
    const order = await deps.loadShopifyOrder(orderName);
    const rateCache = new Map();
    const results = await Promise.all(stage.convertTo.map((to) => deps.quote({
      order, to, expectedFrom: row.shipping?.method ?? null, deliverTo: address, rateCache })));
    const options = [];
    for (const q of results) {
      if (q.ok) {
        options.push({ to: q.to, shipping: centsToDollars(q.shippingCents), tax: centsToDollars(q.taxCents),
          total: centsToDollars(q.totalCents), final: true });
        continue;
      }
      logRefusal(orderName, q.reason);
      if (q.reason !== 'service_unavailable') {
        return json(422, { error: 'unpriceable', reason: refusalCopy(q.reason) });
      }
    }
    if (!options.length) return json(422, { error: 'service_unavailable', reason: SERVICE_UNAVAILABLE_COPY });
    return json(200, { options });
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
      reason: refusalCopy(q.reason),
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

// ── POST /my-order/request ─────────────────────────────────────────────────
// "Send me the invoice". The only route here that changes anything, and only
// behind SHOPIFY_WRITES (deps.commitEdit / deps.sendInvoice refuse otherwise).
//
//   1. re-decide from the current row and re-quote from a fresh staged edit;
//   2. commit ONLY if the balance is still exactly what the page showed —
//      otherwise nothing is committed and the new figure goes back;
//   3. record the pending change (the paid webhook and the expiry job act on
//      it), then ask Shopify to email the invoice for the balance.
// Pickup conversions are not self-committed yet: they need the order's
// address changed first, and that write is not built.
const REVERT_AFTER_MS = 48 * 60 * 60 * 1000;

async function requestChange(deps, authorised, event) {
  // The read-only status function has no write dependencies; only the
  // order-change-request function is built with them.
  if (!deps.commitEdit || !deps.sendInvoice || !deps.savePending) return json(503, { error: 'not_available', reason: NOT_AVAILABLE_COPY });
  let body;
  try { body = JSON.parse(event?.body ?? '{}'); } catch { return json(400, { error: 'bad_json' }); }
  const orderName = String(body.o ?? '').trim();
  const got = await authorised(orderName, String(body.s ?? '').trim());
  if (got.response) return got.response;
  const { row } = got;

  // Products added (or an unpaid choice that carries some): their own path,
  // so the shipping-only path below stays exactly as it was.
  if (Array.isArray(body.addOns) || (await pendingHasAddOns(deps, orderName))) {
    return requestAddOnChange(deps, row, orderName, body);
  }

  const service = String(body.service ?? '');
  const expected = toCents(body.expectedTotal);
  if (expected === null || expected <= 0) return json(400, { error: 'expected_total_missing' });

  const stage = stageFor(row);
  if (!offeredServices(stage).includes(service)) {
    return json(409, { error: 'not_offered', reason: BLOCKED_COPY[stage.blockedBy] ?? UNPRICEABLE_COPY });
  }

  const existing = await deps.loadPending(orderName);
  if (existing?.status === 'pending' && existing.to === service) {
    return json(200, { requested: true, already: true, total: centsToDollars(existing.shippingCents + existing.taxCents),
      ...(existing.paymentUrl ? { paymentUrl: existing.paymentUrl } : {}) });
  }
  if (existing?.status === 'attention') return json(409, { error: 'with_team', reason: WITH_TEAM_COPY });

  const t = timer('POST', orderName);
  let order = await deps.loadShopifyOrder(orderName);
  t.mark('shopifyOrder');
  const line = order?.shippingLines?.length === 1 ? order.shippingLines[0] : null;
  // A different speed while the first choice is unpaid: Shopify still carries
  // that choice and its balance. Priced exactly as the page prices it (the
  // order as it was before the change); the edit replaces the unpaid line in
  // ONE commit and the balance becomes the one for the new choice. A pending
  // record Shopify never received (no balance, original line still there) is
  // simply superseded. Already paid (webhook not yet in) is not switchable.
  // A pickup becoming a delivery: the customer typed the address on the page.
  // It goes on the Shopify order first, so the order edit below taxes the
  // shipping where it will be delivered; what the page showed came from the
  // same address. (An unpaid pickup change already put it there.)
  if (stage.canConvert && existing?.status !== 'pending') {
    if (!deps.setShippingAddress) return json(503, { error: 'not_available', reason: NOT_AVAILABLE_COPY });
    const checked = checkDeliveryAddress(body.address);
    if (checked.response) return checked.response;
    const set = await deps.setShippingAddress({ orderName, orderId: order?.id, address: checked.address });
    if (!set.updated) {
      if (set.skipped) return json(503, { error: 'not_available', reason: NOT_AVAILABLE_COPY });
      console.error(JSON.stringify({ msg: 'shipping address not set', orderName, set }));
      return json(502, { error: 'address_failed', reason: 'We couldn’t save that delivery address. Please check it and try again.' });
    }
    order = await deps.loadShopifyOrder(orderName);
  }

  let switching = false;
  if (existing?.status === 'pending') {
    if (line?.title === existing.to && order.outstandingCents > 0) switching = true;
    else if (order?.outstandingCents > 0) {
      // A balance for something other than the recorded choice: changed by hand.
      logRefusal(orderName, 'switch_line_mismatch');
      return json(422, { error: 'unpriceable', reason: refusalCopy('switch_line_mismatch') });
    } else if (line?.title !== (row.shipping?.method ?? null)) {
      return json(409, { error: 'already_paid', reason: 'Your payment for this change is already in. Refresh in a minute to see it.' });
    }
  }
  const pricedOn = switching ? orderBeforeChange(order, existing) : order;
  if (!pricedOn) {
    logRefusal(orderName, 'switch_unpriceable');
    return json(422, { error: 'unpriceable', reason: UNPRICEABLE_COPY });
  }
  const q = await deps.quote({ order: pricedOn, to: service,
    expectedFrom: switching ? existing.from : (row.shipping?.method ?? null) });
  t.mark('quote');
  if (!q.ok || !q.edit) {
    logRefusal(orderName, q.reason ?? 'no_edit');
    return json(422, { error: 'unpriceable', reason: refusalCopy(q.reason) });
  }
  if (q.totalCents !== expected) {
    return json(409, { error: 'price_changed', total: centsToDollars(q.totalCents),
      shipping: centsToDollars(q.shippingCents), tax: centsToDollars(q.taxCents) });
  }

  const now = deps.now();
  const ref = `CHG-${orderName}-${now}`;
  const change = {
    orderName, ref, status: 'pending',
    orderDeskId: row.source?.orderDeskId ?? null,
    shopifyOrderId: q.edit.orderId,
    from: q.from, to: q.to, shippingCents: q.shippingCents, taxCents: q.taxCents,
    restore: q.edit.restore,
    // A pickup converted to delivery: the address Order Desk must ship to.
    ...(q.deliverTo ? { deliverTo: q.deliverTo } : {}),
    committedAt: new Date(now).toISOString(),
    revertAfter: new Date(now + REVERT_AFTER_MS).toISOString(),
    // A staff test order (seed-test-row.mjs) — marked "(TEST)" in Chat, left
    // out of the daily count.
    ...(row.testOrder ? { test: true } : {}),
  };

  // The record goes in BEFORE Shopify is touched, replacing the unpaid one
  // only if it is still that one. If this function is cut off after the
  // commit, the record already says what Shopify now carries, so the payment
  // webhook can still write Order Desk; if it is cut off before, the record
  // points at a change Shopify never got, which the next request supersedes.
  const save = (c) => deps.savePending(c);
  try {
    await save(existing?.status === 'pending' ? { ...change, replaces: existing.ref } : change);
  } catch {
    return json(409, { error: 'changed_meanwhile', reason: 'This order was just changed. Refresh the page to see the latest options.' });
  }

  const committed = await deps.commitEdit({
    orderName, calculatedOrderId: q.edit.calculatedOrderId,
    staffNote: switching
      ? `Shipping change ${ref}: ${q.from} -> ${q.to}, requested by the customer online (replaces unpaid ${existing.ref}, ${existing.to})`
      : `Shipping change ${ref}: ${q.from} -> ${q.to}, requested by the customer online`,
  });
  t.mark('commit');
  if (!committed.committed) {
    // Nothing changed in Shopify: put the record back the way it was.
    await save(existing?.status === 'pending' ? { ...existing, replaces: ref } : { ...change, status: 'failed', replaces: ref })
      .catch((err) => console.error(JSON.stringify({ msg: 'record rollback failed', orderName, ref, err: String(err) })));
    if (committed.skipped) return json(503, { error: 'not_available', reason: NOT_AVAILABLE_COPY });
    console.error(JSON.stringify({ msg: 'order edit commit failed', orderName, committed }));
    return json(502, { error: 'commit_failed', reason: 'We couldn’t update your order just now — nothing was charged. Please try again in a few minutes.' });
  }

  // Shopify is the authority on what is owed. If the committed balance is not
  // the one quoted, the team looks before anyone pays.
  if (committed.outstandingCents !== q.totalCents) {
    await save({ ...change, status: 'attention', attentionReason: 'commit_balance_mismatch',
      committedOutstandingCents: committed.outstandingCents, replaces: ref });
    return json(502, { error: 'commit_mismatch', reason: WITH_TEAM_COPY });
  }
  // Shopify's invoice for the edited order goes to the customer now, while
  // there is a balance (Shopify refuses one for a paid order): the new
  // service, the amount and a Pay now link, in case they close the payment
  // page (Kai, 2026-10-04). Sent alongside the record write; a failed email
  // never stops the customer reaching the payment page.
  const [, invoice] = await Promise.all([
    save({ ...change, ...(committed.paymentUrl ? { paymentUrl: committed.paymentUrl } : {}), replaces: ref, confirmed: true }),
    deps.sendInvoice({ orderName, orderId: q.edit.orderId,
      customMessage: `Your shipping is changing to ${q.to}. Here is your updated invoice — pay the balance to confirm the change.` })
      .catch((err) => ({ sent: false, error: String(err) })),
  ]);
  if (!invoice.sent) console.error(JSON.stringify({ msg: 'balance invoice not sent', orderName, ref, invoice }));
  t.done();

  // Shopify's own payment page for the balance: the customer pays exactly as
  // they did at checkout, nothing of ours handles the card.
  if (committed.paymentUrl) {
    return json(200, { requested: true, total: centsToDollars(q.totalCents), paymentUrl: committed.paymentUrl,
      invoiceSent: Boolean(invoice.sent) });
  }
  return json(200, { requested: true, total: centsToDollars(q.totalCents), invoiceSent: Boolean(invoice.sent) });
}

// ── add-ons (Kai, 2026-10-08) ─────────────────────────────────────────────
// Products from the Stand / Red Carpets menu added to the customer's order
// (addon-catalog.mjs), alone or together with a faster service: one staged
// edit, one balance, one payment, shipping re-priced like checkout every time.

const ADDON_GONE_COPY = 'One of those items is no longer available. Refresh the page to see the current list.'
  + ' If you have any questions, please contact our team.';
const NOTHING_SELECTED_COPY = 'Choose at least one item to add.';

/** Add-ons are offered wherever a change is (not Completed, not a supplier or sticker order). */
function addOnsOpen(stage) {
  return !['shipping', 'completed_pickup', 'supplier_order', 'sticker_order'].includes(stage.blockedBy);
}

async function addOnList(deps, stage) {
  if (!deps.loadAddOns || !addOnsOpen(stage)) return [];
  try { return await deps.loadAddOns(); } catch { return []; }
}

const publicItem = (a) => ({ product: a.product, title: a.title, sku: a.sku, quantity: a.quantity,
  unit: centsToDollars(a.unitCents ?? a.price) });

function wantsAddOns(event) {
  try { return Array.isArray(JSON.parse(event?.body ?? '{}')?.addOns); } catch { return false; }
}

async function pendingHasAddOns(deps, orderName) {
  if (!deps.loadPending) return false;
  const p = await deps.loadPending(orderName);
  return p?.status === 'pending' && p.addOns?.length > 0;
}

// The faster services while an unpaid choice with add-ons is open: each priced
// as "this service, without those items", so picking one replaces the choice
// the way a shipping-only switch does.
async function quoteUpgradesDroppingAddOns(deps, orderName, options, before, pending) {
  if (!deps.quoteAddOns) return { upgrades: [] };
  const rateCache = new Map();
  const results = await Promise.all(options.map((to) => deps.quoteAddOns({
    order: before, to, addOns: [], removeLineItemIds: pending.addedLineItemIds ?? [], expectedFrom: pending.from, rateCache })));
  const upgrades = [];
  for (const q of results) {
    if (!q.ok) { logRefusal(orderName, q.reason); continue; }
    upgrades.push({ to: q.to, shipping: centsToDollars(q.shippingCents), tax: centsToDollars(q.taxCents),
      total: centsToDollars(q.totalCents), final: true });
  }
  return { upgrades };
}

/** Price the selection. Shared by the quote and the request, so they cannot differ. */
async function priceAddOnChange(deps, row, orderName, body) {
  const stage = stageFor(row);
  if (!addOnsOpen(stage)) {
    return { response: json(409, { error: 'not_offered', reason: BLOCKED_COPY[stage.blockedBy] ?? UNPRICEABLE_COPY }) };
  }
  if (!deps.loadAddOns || !deps.quoteAddOns) return { response: json(503, { error: 'not_available', reason: NOT_AVAILABLE_COPY }) };
  const service = body.service ? String(body.service) : null;
  if (service && !(stage.canUpgrade && (stage.upgradeOptions ?? [stage.upgradeTo]).includes(service))) {
    return { response: json(400, { error: 'service_not_offered' }) };
  }
  const resolved = resolveAddOns(body.addOns ?? [], await deps.loadAddOns());
  if (resolved.error) return { response: json(409, { error: 'addon_not_offered', reason: ADDON_GONE_COPY }) };

  const existing = deps.loadPending ? await deps.loadPending(orderName) : null;
  if (existing?.status === 'attention') return { response: json(409, { error: 'with_team', reason: WITH_TEAM_COPY }) };
  const pendingAddOns = existing?.status === 'pending' && existing.addOns?.length > 0;
  if (!resolved.addOns.length && !pendingAddOns) {
    return { response: json(400, { error: 'nothing_selected', reason: NOTHING_SELECTED_COPY }) };
  }

  const order = await deps.loadShopifyOrder(orderName);
  const line = order?.shippingLines?.length === 1 ? order.shippingLines[0] : null;
  let base = order;
  let removeLineItemIds = [];
  let switching = false;
  let expectedFrom = row.shipping?.method ?? null;
  if (existing?.status === 'pending') {
    if (line?.title === existing.to && order.outstandingCents > 0) {
      switching = true;
      base = orderBeforeChange(order, existing);
      removeLineItemIds = existing.addedLineItemIds ?? [];
      expectedFrom = existing.from;
    } else if (order?.outstandingCents > 0) {
      logRefusal(orderName, 'switch_line_mismatch');
      return { response: json(422, { error: 'unpriceable', reason: refusalCopy('switch_line_mismatch') }) };
    } else if (line?.title !== expectedFrom && !(isPickupTitle(line?.title) && isPickupTitle(expectedFrom))) {
      return { response: json(409, { error: 'already_paid', reason: 'Your payment for this change is already in. Refresh in a minute to see it.' }) };
    }
  }
  if (!base) {
    logRefusal(orderName, 'switch_unpriceable');
    return { response: json(422, { error: 'unpriceable', reason: UNPRICEABLE_COPY }) };
  }
  const q = await deps.quoteAddOns({ order: base, to: service, addOns: resolved.addOns, removeLineItemIds, expectedFrom });
  if (!q.ok) {
    logRefusal(orderName, q.reason);
    return { response: json(422, { error: 'unpriceable', reason: refusalCopy(q.reason) }) };
  }
  return { q, existing, order, switching, addOns: resolved.addOns };
}

const isPickupTitle = (t) => /\b(warehouse|pick\s*-?\s*up|pickup)\b/i.test(String(t ?? ''));

const quoteBody = (q, addOns) => ({
  items: addOns.map(publicItem),
  itemsTotal: centsToDollars(q.itemsCents),
  shippingService: q.to,
  shipping: centsToDollars(q.shippingCents),
  tax: centsToDollars(q.taxCents),
  total: centsToDollars(q.totalCents),
});

// ── POST /my-order/quote with addOns ──  read only: a staged edit, never committed.
async function quoteAddOns(deps, authorised, event) {
  let body;
  try { body = JSON.parse(event?.body ?? '{}'); } catch { return json(400, { error: 'bad_json' }); }
  const orderName = String(body.o ?? '').trim();
  const got = await authorised(orderName, String(body.s ?? '').trim());
  if (got.response) return got.response;
  const priced = await priceAddOnChange(deps, got.row, orderName, body);
  if (priced.response) return priced.response;
  return json(200, quoteBody(priced.q, priced.addOns));
}

// ── POST /my-order/request with addOns ──  commit, invoice, Shopify's payment page.
async function requestAddOnChange(deps, row, orderName, body) {
  const expected = toCents(body.expectedTotal);
  if (expected === null || expected <= 0) return json(400, { error: 'expected_total_missing' });
  const t = timer('POST-addons', orderName);
  const priced = await priceAddOnChange(deps, row, orderName, body);
  if (priced.response) return priced.response;
  const { q, existing, order, switching, addOns } = priced;
  t.mark('quote');
  if (q.totalCents !== expected) {
    return json(409, { error: 'price_changed', ...quoteBody(q, addOns) });
  }

  const now = deps.now();
  const ref = `CHG-${orderName}-${now}`;
  const change = {
    orderName, ref, status: 'pending', kind: 'addons',
    orderDeskId: row.source?.orderDeskId ?? null,
    shopifyOrderId: q.edit.orderId,
    from: q.from, to: q.to, shippingCents: q.shippingCents, taxCents: q.taxCents, itemsCents: q.itemsCents,
    addOns: addOns.map((a) => ({ variantId: a.variantId, sku: a.sku, product: a.product, title: a.title,
      quantity: a.quantity, unitCents: a.price })),
    restore: q.edit.restore,
    committedAt: new Date(now).toISOString(),
    revertAfter: new Date(now + REVERT_AFTER_MS).toISOString(),
    ...(row.testOrder ? { test: true } : {}),
  };
  const save = (c) => deps.savePending(c);
  try {
    await save(existing?.status === 'pending' ? { ...change, replaces: existing.ref } : change);
  } catch {
    return json(409, { error: 'changed_meanwhile', reason: 'This order was just changed. Refresh the page to see the latest options.' });
  }
  const what = addOns.map((a) => `${a.product} ${a.title} x${a.quantity}`).join(', ');
  const committed = await deps.commitEdit({
    orderName, calculatedOrderId: q.edit.calculatedOrderId,
    staffNote: `Order change ${ref}: add ${what || '(no items)'}`
      + (q.to !== q.from ? `; shipping ${q.from} -> ${q.to}` : '')
      + ', requested by the customer online' + (switching ? ` (replaces unpaid ${existing.ref})` : ''),
  });
  t.mark('commit');
  if (!committed.committed) {
    await save(existing?.status === 'pending' ? { ...existing, replaces: ref } : { ...change, status: 'failed', replaces: ref })
      .catch((err) => console.error(JSON.stringify({ msg: 'record rollback failed', orderName, ref, err: String(err) })));
    if (committed.skipped) return json(503, { error: 'not_available', reason: NOT_AVAILABLE_COPY });
    console.error(JSON.stringify({ msg: 'order edit commit failed', orderName, committed }));
    return json(502, { error: 'commit_failed', reason: 'We couldn’t update your order just now — nothing was charged. Please try again in a few minutes.' });
  }
  if (committed.outstandingCents !== q.totalCents) {
    await save({ ...change, status: 'attention', attentionReason: 'commit_balance_mismatch',
      committedOutstandingCents: committed.outstandingCents, replaces: ref });
    return json(502, { error: 'commit_mismatch', reason: WITH_TEAM_COPY });
  }
  // The add-ons' own lines on the Shopify order: the ones this commit created.
  const before = new Set(order.lineItemIds ?? []);
  const addedLineItemIds = (committed.lineItems ?? []).filter((l) => !before.has(l.id) && l.quantity > 0).map((l) => l.id);
  const message = `We've added ${what} to your order`
    + (q.to !== q.from ? ` and your shipping is changing to ${q.to}` : '')
    + '. Here is your updated invoice — pay the balance to confirm.';
  const [, invoice] = await Promise.all([
    save({ ...change, addedLineItemIds, ...(committed.paymentUrl ? { paymentUrl: committed.paymentUrl } : {}),
      replaces: ref, confirmed: true }),
    deps.sendInvoice({ orderName, orderId: q.edit.orderId, customMessage: message })
      .catch((err) => ({ sent: false, error: String(err) })),
  ]);
  if (!invoice.sent) console.error(JSON.stringify({ msg: 'balance invoice not sent', orderName, ref, invoice }));
  t.done();
  return json(200, { requested: true, total: centsToDollars(q.totalCents), invoiceSent: Boolean(invoice.sent),
    ...(committed.paymentUrl ? { paymentUrl: committed.paymentUrl } : {}) });
}
