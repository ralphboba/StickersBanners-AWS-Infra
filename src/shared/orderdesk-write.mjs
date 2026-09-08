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

/** Legacy folderLib/tagLib live with the gate — one place for both. */
import { ORDERDESK_FOLDERS, ORDERDESK_TAGS } from './intake-gate.mjs';
import { orderDeskFetch, orderDeskHeaders, ORDERDESK_API } from './orderdesk-fetch.mjs';

/** Synthetic orders never touch OrderDesk, whatever the flag says. */
function isSyntheticOrder(name) {
  return /^(DEMO-|ZZ-)/i.test(String(name ?? ''));
}

/**
 * Is the real OrderDesk write switched on? Defaults to OFF.
 * Deliberately an exact match on "enabled" so a stray truthy value (e.g. "0",
 * "false", "no") cannot arm it by accident.
 */
export function orderDeskWritesEnabled() {
  return String(process.env.ORDERDESK_WRITES ?? '').trim().toLowerCase() === 'enabled';
}

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
