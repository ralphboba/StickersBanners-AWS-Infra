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
import { ORDERDESK_FOLDERS, ORDERDESK_TAGS } from './intake-gate.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from './orderdesk-fetch.mjs';
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
 * @param {string} p.tag          colour name from ORDERDESK_TAGS, e.g. "Red"
 * @param {string} p.folder       key from ORDERDESK_FOLDERS, e.g. "manual"
 * @param {string} p.storeId
 * @param {string} p.apiKey
 * @returns {Promise<{ applied: boolean, skipped?: 'disabled'|'synthetic',
 *                     folderId?: string, tagValue?: string, error?: string }>}
 */
export async function updateOrderDeskDetails({
  order, orderName, tag, folder, storeId, apiKey,
}) {
  const folderId = ORDERDESK_FOLDERS[folder];
  const tagValue = ORDERDESK_TAGS[tag];
  const intent = { folder, folderId, tag, tagValue };

  if (isSyntheticOrder(orderName)) {
    console.log(JSON.stringify({
      msg: 'orderdesk move skipped (synthetic order)', orderName, ...intent,
    }));
    return { applied: false, skipped: 'synthetic', folderId, tagValue };
  }

  if (!orderDeskWritesEnabled()) {
    // The prototype path: say exactly what would have happened, change nothing.
    console.log(JSON.stringify({
      msg: 'orderdesk move WOULD HAVE RUN (writes disabled)', orderName, ...intent,
    }));
    return { applied: false, skipped: 'disabled', folderId, tagValue };
  }

  const orderDeskId = String(order?.id ?? '');
  if (!orderDeskId || !folderId || !tagValue) {
    return { applied: false, error: 'missing order id, folder or tag', folderId, tagValue };
  }

  // Legacy keeps the existing value when the lookup misses; ours cannot miss
  // (guarded above), but the spread-then-override shape is the same.
  const updated = { ...order, tag_name: tagValue, folder_id: folderId };
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
 *  2. Moves the money. shipping_total and order_total both shift by the
 *     difference; leaving order_total alone would make OrderDesk disagree with
 *     what the customer actually paid.
 *  3. Refuses a repeat. See upgradeAlreadyApplied.
 *
 * It does NOT move the order between folders. The upgrade keeps the order with
 * whichever production team already has it — see the ladder rule in
 * docs/order-lifecycle-and-refunds.md.
 *
 * @param {object}   p
 * @param {string}   p.orderDeskId    OrderDesk order id (we always know it)
 * @param {string}   p.orderName      for the synthetic-order guard and logs
 * @param {string}   p.toMethod       e.g. "1-day Shipping" — legacy's spelling
 * @param {number}   p.amount         the difference paid, in dollars
 * @param {string}   p.invoiceRef     e.g. "D169" — the idempotency key
 * @param {string}   p.storeId
 * @param {string}   p.apiKey
 * @param {typeof fetch} [p.fetchImpl]
 */
export async function applyShippingUpgrade({
  orderDeskId, orderName, toMethod, amount, invoiceRef, storeId, apiKey, fetchImpl,
}) {
  const deltaCents = cents(amount);
  const intent = { orderDeskId, toMethod, amount: dollars(deltaCents), invoiceRef };
  const opts = fetchImpl ? { fetchImpl } : {};

  const blocked = blockedReason(orderName, orderDeskUpgradeWritesEnabled);
  if (blocked) {
    console.log(JSON.stringify({
      msg: `shipping upgrade WOULD HAVE RUN (${blocked.skipped})`, orderName, ...intent,
    }));
    return { applied: false, ...blocked, intent };
  }

  if (!orderDeskId || !toMethod) return { applied: false, error: 'missing order id or target' };
  if (deltaCents <= 0) return { applied: false, error: 'upgrade amount must be positive' };

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
    order_total: dollars(cents(fresh.order_total) + deltaCents),
    order_notes: [
      ...(fresh.order_notes ?? []),
      {
        username: 'SBBot',
        date_added: stamp,
        content: `Shipping upgraded ${from} -> ${toMethod} by customer, +$${dollars(deltaCents)} (${invoiceRef})`,
      },
    ],
  };
  // shipping_total is only touched when the record actually carries it, so a
  // store that does not use the field does not gain a spurious one.
  if (fresh.shipping_total !== undefined && fresh.shipping_total !== null) {
    updated.shipping_total = dollars(cents(fresh.shipping_total) + deltaCents);
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
    orderTotal: updated.order_total,
    shippingTotal: updated.shipping_total,
  };
}
