// OrderDesk writes — ported from legacy updateOrderdeskDetails
// (src/utils/helpers/updateOrder.mjs).
//
// ⚠️  THIS IS THE ONLY CODE IN THE PROJECT THAT MOVES A REAL ORDER. ⚠️
//
// The legacy bot re-tags an order and moves it between OrderDesk folders as it
// works: gated orders go to sales/manual, routed orders go to the facility
// folder. Reproducing that faithfully is required for the day Linh's program is
// switched off and this one takes over.
//
// Until then it is a prototype: the decision runs, is logged, and is recorded
// for the dashboard, but the HTTP call does not happen. The write is off unless
// ORDERDESK_WRITES is explicitly set to "enabled", and synthetic DEMO-*/ZZ-*
// orders can never write regardless of that setting.
//
// Turning it on is a go-live action and needs Kai's explicit approval (see
// CLAUDE.md "Safety"). Everything else in the pipeline works the same either
// way, so the flow is fully observable with writes off.
//
// Two features live here, on two different switches, because keeping every
// OrderDesk write in one file is worth more than splitting them by feature —
// "what can write to a real order?" has one answer, and it is this file.
//
//   ORDERDESK_WRITES          updateOrderDeskDetails, applyExpressUpgrade
//                             (legacy intake behaviour, ported from Linh)
//   ORDERDESK_UPGRADE_WRITES  applyShippingUpgrade
//                             (the customer-paid upgrade — see write-gates.mjs)

/** Legacy folderLib/tagLib live with the gate — one place for both. */
import { folderIds, ORDERDESK_TAGS } from './intake-gate.mjs';
import { isPickup } from './order-stage.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from './orderdesk-fetch.mjs';
import { TEST_FOLDERS, testLaneEnabled, isTestFolder } from './test-lane.mjs';
import {
  isSyntheticOrder, orderDeskWritesEnabled,
  orderDeskUpgradeWritesEnabled, blockedReason,
} from './write-gates.mjs';

// Re-exported so existing importers (poller, tests) keep their import path.
export { orderDeskWritesEnabled };

/**
 * Legacy updateOrderdeskDetails: set the order's tag and folder, leaving every
 * other field as-is (legacy PUTs the whole record back with those two changed).
 *
 * Returns what happened so the caller can record it either way — the shape is
 * the same whether or not the write actually went out.
 *
 * @param {object} p
 * @param {object} p.order        the raw OrderDesk order (needed for the PUT body)
 * @param {string} p.orderName    source_id, for logging and the synthetic guard
 * @param {string} [p.tag]        colour name from ORDERDESK_TAGS, e.g. "Red".
 *                                Omitted: the order keeps the tag it has.
 * @param {string} p.folder       key from ORDERDESK_FOLDERS, e.g. "manual"
 * @param {string} p.storeId
 * @param {string} p.apiKey
 * @param {boolean} [p.testLane]  Kai's test lane (shared/test-lane.mjs): the
 *                                order goes to the Kai-TEST-* folder instead,
 *                                and ORDERDESK_WRITES does not hold it. Only
 *                                with TEST_LANE enabled on the function.
 * @returns {Promise<{ applied: boolean, skipped?: 'disabled'|'synthetic',
 *                     folderId?: string, tagValue?: string, error?: string }>}
 */
export async function updateOrderDeskDetails({
  order, orderName, tag, folder, storeId, apiKey, testLane = false,
}) {
  const test = testLane === true && testLaneEnabled();
  const folderId = test ? TEST_FOLDERS[folder] : folderIds()[folder];
  const keepTag = tag === undefined;
  const tagValue = keepTag ? undefined : ORDERDESK_TAGS[tag];
  const intent = { folder, folderId, tag: keepTag ? '(unchanged)' : tag, tagValue, ...(test ? { testLane: true } : {}) };

  if (isSyntheticOrder(orderName)) {
    console.log(JSON.stringify({
      msg: 'orderdesk move skipped (synthetic order)', orderName, ...intent,
    }));
    return { applied: false, skipped: 'synthetic', folderId, tagValue };
  }

  // A test-lane move may only ever land in a Kai-TEST-* folder.
  if (test && !isTestFolder(folderId)) {
    return { applied: false, error: `no test folder for ${folder}`, folderId, tagValue };
  }

  if (!test && !orderDeskWritesEnabled()) {
    // The prototype path: say exactly what would have happened, change nothing.
    console.log(JSON.stringify({
      msg: 'orderdesk move WOULD HAVE RUN (writes disabled)', orderName, ...intent,
    }));
    return { applied: false, skipped: 'disabled', folderId, tagValue };
  }

  const orderDeskId = String(order?.id ?? '');
  if (!orderDeskId || !folderId || (!keepTag && !tagValue)) {
    return { applied: false, error: 'missing order id, folder or tag', folderId, tagValue };
  }

  // Legacy keeps the existing value when the lookup misses; ours cannot miss
  // (guarded above), but the spread-then-override shape is the same.
  const updated = keepTag
    ? { ...order, folder_id: folderId }
    : { ...order, tag_name: tagValue, folder_id: folderId };
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${orderDeskId}`, {
    method: 'PUT',
    headers: orderDeskHeaders(storeId, apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(updated),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { applied: false, error: `OrderDesk ${res.status}: ${body}`, folderId, tagValue };
  }
  console.log(JSON.stringify({ msg: 'orderdesk move applied', orderName, ...intent }));
  return { applied: true, folderId, tagValue };
}

/**
 * Legacy changeExpress: a 3-day order placed between 3pm and 6pm ET is upgraded
 * to 2-day, with a note appended so staff can see why. routeOrder decides this
 * and returns it as an intent; performing it is a write, so it goes through the
 * same kill switch as the folder move.
 *
 * @param {{ order: object, orderName: string,
 *           upgrade: { to: string, note: string },
 *           storeId: string, apiKey: string }} p
 */
export async function applyExpressUpgrade({ order, orderName, upgrade, storeId, apiKey }) {
  const intent = { from: order?.shipping_method, to: upgrade?.to, note: upgrade?.note };

  if (isSyntheticOrder(orderName)) {
    console.log(JSON.stringify({ msg: 'express upgrade skipped (synthetic order)', orderName, ...intent }));
    return { applied: false, skipped: 'synthetic' };
  }
  if (!orderDeskWritesEnabled()) {
    console.log(JSON.stringify({
      msg: 'express upgrade WOULD HAVE RUN (writes disabled)', orderName, ...intent,
    }));
    return { applied: false, skipped: 'disabled' };
  }

  const orderDeskId = String(order?.id ?? '');
  if (!orderDeskId || !upgrade?.to) return { applied: false, error: 'missing order id or target' };

  // Legacy formats the note timestamp in America/New_York, the same clock the
  // cutoff is measured against.
  const stamp = new Date().toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(',', '');

  const updated = {
    ...order,
    shipping_method: upgrade.to,
    order_notes: [
      ...(order.order_notes ?? []),
      { username: 'SBBot', date_added: stamp, content: upgrade.note },
    ],
  };
  const res = await orderDeskFetch(`${ORDERDESK_API}/orders/${orderDeskId}`, {
    method: 'PUT',
    headers: orderDeskHeaders(storeId, apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(updated),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    return { applied: false, error: `OrderDesk ${res.status}: ${body}` };
  }
  console.log(JSON.stringify({ msg: 'express upgrade applied', orderName, ...intent }));
  return { applied: true };
}

// ───────────────────────────────────────────────────────────────────────────
// The customer-paid shipping upgrade.
// ───────────────────────────────────────────────────────────────────────────

/** Money in cents, so 278.11 + 33.96 cannot drift to 312.06999999999996. */
const cents = (v) => Math.round(Number(v ?? 0) * 100);
const dollars = (c) => (c / 100).toFixed(2);

/**
 * Has this exact upgrade already been written? Shopify delivers a webhook more
 * than once often enough that assuming otherwise is a money bug — a second
 * delivery would add the difference to the total a second time.
 *
 * The invoice number is the natural idempotency key: one invoice, one upgrade.
 */
export function upgradeAlreadyApplied(order, invoiceRef) {
  if (!invoiceRef) return false;
  return (order?.order_notes ?? []).some(
    (n) => String(n?.content ?? '').includes(invoiceRef),
  );
}

/**
 * Write a paid shipping upgrade onto the OrderDesk order: the service, and the
 * money that came with it.
 *
 * Three things this does that applyExpressUpgrade does not:
 *
 *  1. RE-READS the order immediately before writing and merges onto that copy.
 *     Legacy PUTs a record it read earlier, which silently reverts anything the
 *     office changed in between (docs/shopify-intake-lambda.md, H2). This runs
 *     while staff are working the same order, so the window is real.
 *  2. Moves the money, all three parts of it. The shipping charge, the tax
 *     charged on it, and the grand total go to different fields, and putting
 *     the whole amount in one of them would leave OrderDesk internally
 *     inconsistent — the totals would not add up.
 *  3. Refuses a repeat. See upgradeAlreadyApplied.
 *
 * It does NOT move the order between folders. The upgrade keeps the order with
 * whichever production team already has it — see the ladder rule in
 * docs/order-lifecycle-and-refunds.md.
 *
 * A pickup converted to a delivery goes through here too, with `deliverTo`:
 * the address the customer typed and paid for. The two are tied both ways —
 * a pickup is refused without an address (it would become a delivery to
 * nowhere), and an address is refused on an order that is not a pickup (an
 * upgrade must never quietly re-address a shipment).
 *
 * @param {object}   p
 * @param {string}   p.orderDeskId    OrderDesk order id (we always know it)
 * @param {string}   p.orderName      for the synthetic-order guard and logs
 * @param {string}   p.toMethod       e.g. "FedEx 1-Day" — exactly as the store spells it
 * @param {number}   p.amount         the shipping difference, BEFORE tax
 * @param {number}   [p.tax]          tax Shopify charged on that difference (0 if none)
 * @param {string}   p.invoiceRef     e.g. "D169" — the idempotency key
 * @param {{address1: string, address2?: string, city: string, province: string,
 *          zip: string, country?: string}} [p.deliverTo]  pickup conversions only
 * @param {string}   p.storeId
 * @param {string}   p.apiKey
 * @param {typeof fetch} [p.fetchImpl]
 */
export async function applyShippingUpgrade({
  orderDeskId, orderName, toMethod, amount, tax = 0, invoiceRef, deliverTo, storeId, apiKey, fetchImpl,
  // Add-ons (Kai, 2026-10-08): products the customer added and paid for, and
  // what Shopify charged for them before tax. Each becomes an item on the
  // OrderDesk order. `amount` is then the shipping re-price (may be 0).
  addOns = [], items = 0,
}) {
  // Three numbers, and they must be kept apart. `amount` is the shipping
  // charge; `tax` is what Shopify charged on it; their sum is what left the
  // customer's card. They land in three different OrderDesk fields.
  //
  // We never compute the tax ourselves — rates vary by destination and by what
  // is being taxed, and a number we invented would disagree with the money that
  // actually moved. It comes from Shopify and is passed straight through.
  const deltaCents = cents(amount);
  const taxCents = cents(tax);
  const itemsCents = cents(items);
  const hasAddOns = Array.isArray(addOns) && addOns.length > 0;
  const paidCents = deltaCents + taxCents + (hasAddOns ? itemsCents : 0);
  const intent = {
    orderDeskId, toMethod, invoiceRef,
    amount: dollars(deltaCents), tax: dollars(taxCents), paid: dollars(paidCents),
    ...(deliverTo ? { deliverTo } : {}),
    ...(hasAddOns ? { items: dollars(itemsCents), addOns: addOns.map((a) => `${a.sku} x${a.quantity}`) } : {}),
  };
  const opts = fetchImpl ? { fetchImpl } : {};

  const blocked = blockedReason(orderName, orderDeskUpgradeWritesEnabled);
  if (blocked) {
    console.log(JSON.stringify({
      msg: `shipping upgrade WOULD HAVE RUN (${blocked.skipped})`, orderName, ...intent,
    }));
    return { applied: false, ...blocked, intent };
  }

  if (!orderDeskId || !toMethod) return { applied: false, error: 'missing order id or target' };
  if (hasAddOns) {
    if (itemsCents <= 0 || paidCents <= 0) return { applied: false, error: 'add-on amount must be positive' };
    if (addOns.some((a) => !a?.sku || !Number.isSafeInteger(a?.quantity) || a.quantity <= 0)) {
      return { applied: false, error: 'add-on without sku or quantity' };
    }
  } else if (deltaCents <= 0) return { applied: false, error: 'upgrade amount must be positive' };
  if (taxCents < 0) return { applied: false, error: 'tax cannot be negative' };

  // 1. Re-read. This copy, not one fetched minutes ago, is what we merge onto.
  const url = `${ORDERDESK_API}/orders/${orderDeskId}`;
  const getRes = await orderDeskFetch(url, { headers: orderDeskHeaders(storeId, apiKey) }, opts);
  if (!getRes.ok) {
    const body = (await getRes.text()).slice(0, 200);
    return { applied: false, error: `OrderDesk GET ${getRes.status}: ${body}` };
  }
  const fresh = (await getRes.json())?.order;
  if (!fresh) return { applied: false, error: 'OrderDesk returned no order' };

  // 2. Already done? A duplicate webhook must not charge the record twice.
  if (upgradeAlreadyApplied(fresh, invoiceRef)) {
    console.log(JSON.stringify({ msg: 'shipping upgrade already applied', orderName, ...intent }));
    return { applied: false, skipped: 'duplicate', intent };
  }

  // Pickup and address go together, judged on the FRESH record: the office may
  // have changed the method since the customer was quoted.
  // A pickup is converted only when the new service is a delivery; a pickup
  // that only adds products stays a pickup.
  const converting = isPickup(fresh.shipping_method) && !isPickup(toMethod);
  if (converting && !deliverTo) {
    return { applied: false, error: 'pickup order needs a delivery address' };
  }
  if (!converting && deliverTo) {
    return { applied: false, error: 'address given for an order that is not a pickup' };
  }
  if (converting && !(deliverTo.address1 && deliverTo.city && deliverTo.province && deliverTo.zip)) {
    return { applied: false, error: 'delivery address incomplete' };
  }

  // 3. Merge. Only these fields change; everything else is the fresh copy.
  const stamp = new Date().toLocaleString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(',', '');

  const from = fresh.shipping_method;
  const updated = {
    ...fresh,
    shipping_method: toMethod,
    // Only the address lines change. Name, company, phone and email stay as
    // the customer gave them at checkout.
    ...(converting ? {
      shipping: {
        ...(fresh.shipping ?? {}),
        address1: deliverTo.address1,
        address2: deliverTo.address2 ?? '',
        city: deliverTo.city,
        state: deliverTo.province,
        postal_code: deliverTo.zip,
        country: deliverTo.country || 'US',
      },
    } : {}),
    // The grand total moves by everything the customer paid, tax included.
    order_total: dollars(cents(fresh.order_total) + paidCents),
    // The added products, as items the production team will see and ship.
    ...(hasAddOns ? { order_items: [
      ...(fresh.order_items ?? []),
      ...addOns.map((a) => ({
        name: a.title && a.title !== a.product ? `${a.product} - ${a.title}` : a.product,
        code: a.sku, quantity: a.quantity, price: Number(dollars(a.unitCents)),
      })),
    ] } : {}),
    order_notes: [
      ...(fresh.order_notes ?? []),
      {
        username: 'SBBot',
        date_added: stamp,
        content: (hasAddOns
          ? `Added by customer: ${addOns.map((a) => `${a.product}${a.title && a.title !== a.product ? ` ${a.title}` : ''} (${a.sku}) x${a.quantity}`).join(', ')}`
            + ` +$${dollars(itemsCents)}`
            + (from !== toMethod ? `; shipping ${from} -> ${toMethod}` : '; shipping re-priced')
            + ` ${deltaCents >= 0 ? '+' : '-'}$${dollars(Math.abs(deltaCents))}`
            + ` + $${dollars(taxCents)} tax = $${dollars(paidCents)}`
          : `${converting ? 'Pickup converted to delivery' : 'Shipping upgraded'} `
            + `${from} -> ${toMethod} by customer, +$${dollars(deltaCents)}`
            + (taxCents > 0 ? ` + $${dollars(taxCents)} tax = $${dollars(paidCents)}` : ''))
          + ` (${invoiceRef})`
          + (converting ? `. Deliver to: ${[deliverTo.address1, deliverTo.address2, deliverTo.city,
            deliverTo.province, deliverTo.zip].filter(Boolean).join(', ')}` : ''),
      },
    ],
  };
  // shipping_total and tax_total are only touched when the record actually
  // carries them, so a store that does not use a field does not gain one.
  // Note each takes its OWN number, not the total: shipping gets the shipping
  // charge, tax gets the tax.
  if (fresh.shipping_total !== undefined && fresh.shipping_total !== null) {
    updated.shipping_total = dollars(cents(fresh.shipping_total) + deltaCents);
  }
  if (taxCents > 0 && fresh.tax_total !== undefined && fresh.tax_total !== null) {
    updated.tax_total = dollars(cents(fresh.tax_total) + taxCents);
  }

  const putRes = await orderDeskFetch(url, {
    method: 'PUT',
    headers: orderDeskHeaders(storeId, apiKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(updated),
  }, opts);
  if (!putRes.ok) {
    const body = (await putRes.text()).slice(0, 200);
    return { applied: false, error: `OrderDesk PUT ${putRes.status}: ${body}` };
  }

  console.log(JSON.stringify({ msg: 'shipping upgrade applied', orderName, from, ...intent }));
  return {
    applied: true,
    from,
    to: toMethod,
    converted: converting,
    orderTotal: updated.order_total,
    shippingTotal: updated.shipping_total,
    taxTotal: updated.tax_total,
    paid: dollars(paidCents),
  };
}
