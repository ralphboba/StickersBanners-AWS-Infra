// Changing the shipping on the customer's own Shopify order (Order Edit).
//
// Why an edit and not a draft-order invoice: a paid draft becomes a NEW order,
// which Order Desk imports and the intake Lambda files into QTS — a phantom job
// per upgrade. An edit keeps the order number; Shopify leaves an outstanding
// balance and invoices the customer for exactly that. Tested on S64262 and
// S64227 (2026-09-28): no new order, and Order Desk/the intake Lambda did not
// react to the edit at all.
//
// Why the QUOTE comes from the edit too: Shopify rounds tax per jurisdiction on
// the order as a whole. On S64227, $68.17 more shipping at 8.9% is $6.07 by
// multiplication but $6.08 on the edited order. A quote from anything else can
// miss the charge by a cent, so the quote is the staged edit's own
// outstanding balance — staged, read, and never committed.
//
// Shopify cannot update an original shipping line in place (only lines added
// in the same edit), so a change is: remove the old line, add the new one at
// the full new price. The balance is then the difference plus its tax.

import { shopifyGraphQL } from './shopify-fetch.mjs';
import { toCents, centsToAmount } from './money.mjs';
import { blockedReason, shopifyWritesEnabled } from './write-gates.mjs';

const BEGIN = `
  mutation EditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id shippingLines { id title stagedStatus price { shopMoney { amount } } } }
      userErrors { field message }
    }
  }
`;

const STAGE = `
  mutation EditStage($id: ID!, $remove: ID!, $add: OrderEditAddShippingLineInput!) {
    removed: orderEditRemoveShippingLine(id: $id, shippingLineId: $remove) { userErrors { field message } }
    added: orderEditAddShippingLine(id: $id, shippingLine: $add) {
      calculatedOrder {
        id
        totalPriceSet { shopMoney { amount currencyCode } }
        totalOutstandingSet { shopMoney { amount currencyCode } }
        shippingLines { id title stagedStatus price { shopMoney { amount } } }
      }
      userErrors { field message }
    }
  }
`;

const COMMIT = `
  mutation EditCommit($id: ID!, $note: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $note) {
      order {
        id name displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } }
        paymentCollectionDetails { additionalPaymentCollectionUrl }
        lineItems(first: 100) { nodes { id currentQuantity } }
      }
      userErrors { field message }
    }
  }
`;

const INVOICE = `
  mutation BalanceInvoice($id: ID!, $email: EmailInput) {
    orderInvoiceSend(id: $id, email: $email) { order { id name } userErrors { field message } }
  }
`;

/** The numeric tail of a gid, e.g. gid://shopify/ShippingLine/123 -> "123". */
const tail = (gid) => String(gid ?? '').split('/').pop();

/**
 * Stage "remove this line, add that one" and read what the customer would owe.
 * Nothing is committed; an uncommitted edit simply expires.
 *
 * @param {object} p
 * @param {string} p.orderId       gid://shopify/Order/…
 * @param {string} p.removeLineId  the current shipping line (gid://shopify/ShippingLine/…)
 * @param {string} p.title         the new service, e.g. "FedEx 3-Days"
 * @param {number} p.priceCents    its full price
 * @param {number} p.totalBeforeCents  the order's current total, to check the arithmetic
 * @param {Promise} [p.begun]     result of beginOrderEdit started earlier (optional)
 * @returns {Promise<{ ok: true, calculatedOrderId: string, outstandingCents: number,
 *                     totalCents: number } | { ok: false, reason: string }>}
 */
/** Open an order edit (uncommitted; it simply expires if never used). */
export function beginOrderEdit({ shop, token, orderId, fetchImpl }) {
  return shopifyGraphQL({ shop, token, fetchImpl, query: BEGIN, variables: { id: orderId } });
}

export async function stageShippingChange({
  shop, token, orderId, removeLineId, title, priceCents, totalBeforeCents, begun: begunEarly, fetchImpl,
}) {
  // 0 is a free line (a pickup put back by set-test-shipping.mjs); never negative.
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return { ok: false, reason: 'bad_price' };
  // `begun`: an edit the caller opened earlier, while it was still looking up
  // rates — saves one Shopify round trip on the customer's page.
  const begun = await (begunEarly ?? beginOrderEdit({ shop, token, orderId, fetchImpl }));
  const b = begun?.data?.orderEditBegin;
  if ((b?.userErrors ?? []).length || !b?.calculatedOrder?.id) return { ok: false, reason: 'edit_begin_failed' };

  // The calculated line carries the same number as the order's line.
  const line = b.calculatedOrder.shippingLines.find((l) => tail(l.id) === tail(removeLineId));
  if (!line) return { ok: false, reason: 'shipping_line_not_found' };

  const staged = await shopifyGraphQL({
    shop, token, fetchImpl, query: STAGE,
    variables: {
      id: b.calculatedOrder.id,
      remove: line.id,
      add: { title, price: { amount: centsToAmount(priceCents), currencyCode: 'USD' } },
    },
  });
  const r = staged?.data;
  if ((r?.removed?.userErrors ?? []).length || (r?.added?.userErrors ?? []).length) {
    return { ok: false, reason: 'edit_stage_failed' };
  }
  const c = r?.added?.calculatedOrder;
  const outstandingCents = toCents(c?.totalOutstandingSet?.shopMoney?.amount);
  const totalCents = toCents(c?.totalPriceSet?.shopMoney?.amount);
  const currency = c?.totalOutstandingSet?.shopMoney?.currencyCode;
  if (outstandingCents === null || totalCents === null || (currency && currency !== 'USD')) {
    return { ok: false, reason: 'edit_unreadable' };
  }
  // The balance is exactly what the edit adds to a fully paid order.
  if (Number.isSafeInteger(totalBeforeCents) && totalCents - totalBeforeCents !== outstandingCents) {
    return { ok: false, reason: 'edit_inconsistent' };
  }
  return { ok: true, calculatedOrderId: c.id, outstandingCents, totalCents };
}

// ── add-ons (Kai, 2026-10-08) ──────────────────────────────────────────────
// Products added to the customer's own order, in the same staged edit as any
// shipping change, so one balance and one payment cover both.

const BEGIN_ITEMS = `
  mutation EditBeginItems($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount } }
        shippingLines { id title stagedStatus price { shopMoney { amount } } }
        lineItems(first: 100) { nodes { id quantity } }
      }
      userErrors { field message }
    }
  }
`;

const CALC_FIELDS = `calculatedOrder {
        id
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount } }
        totalOutstandingSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }`;

/** One document: take unpaid add-ons back out, then add the new ones, in order. */
export function itemsDocument(removeCount, addCount) {
  const vars = ['$id: ID!'];
  const parts = [];
  for (let i = 0; i < removeCount; i += 1) {
    vars.push(`$l${i}: ID!`);
    parts.push(`r${i}: orderEditSetQuantity(id: $id, lineItemId: $l${i}, quantity: 0) { ${CALC_FIELDS} }`);
  }
  for (let i = 0; i < addCount; i += 1) {
    vars.push(`$v${i}: ID!`, `$q${i}: Int!`);
    parts.push(`a${i}: orderEditAddVariant(id: $id, variantId: $v${i}, quantity: $q${i}, allowDuplicates: true) { ${CALC_FIELDS} }`);
  }
  return `mutation EditItems(${vars.join(', ')}) {\n  ${parts.join('\n  ')}\n}`;
}

const SHIP_STAGE = `
  mutation EditShip($id: ID!, $remove: ID!, $add: OrderEditAddShippingLineInput!) {
    removed: orderEditRemoveShippingLine(id: $id, shippingLineId: $remove) { userErrors { field message } }
    added: orderEditAddShippingLine(id: $id, shippingLine: $add) {
      ${CALC_FIELDS}
    }
  }
`;

const money2 = (c) => toCents(c?.shopMoney?.amount);

/**
 * Stage an order change that may add products, take back unpaid add-ons and
 * change the shipping line, and read the balance. Nothing is committed.
 *
 * The shipping line is decided AFTER the items are in, from the edit's own new
 * subtotal (`shippingFor`), because checkout's rate depends on the subtotal
 * (Kai: "체크아웃처럼 배송비 다시 계산 … 항상").
 *
 * @param {object} p
 * @param {string} p.orderId
 * @param {string[]} [p.removeLineItemIds]  order line items (unpaid add-ons) to set to 0
 * @param {Array<{variantId: string, quantity: number}>} [p.addVariants]
 * @param {(newSubtotalCents: number, calc: object) => Promise<null | {removeLineId: string, title: string, priceCents: number} | {error: string}>} p.shippingFor
 * @param {number} p.totalBeforeCents
 * @returns {Promise<{ ok: true, calculatedOrderId: string, subtotalBeforeCents: number, subtotalCents: number,
 *                     outstandingCents: number, totalCents: number, shipping: object|null } | { ok: false, reason: string }>}
 */
export async function stageOrderChange({
  shop, token, orderId, removeLineItemIds = [], addVariants = [], shippingFor, totalBeforeCents, fetchImpl,
}) {
  const begun = await shopifyGraphQL({ shop, token, fetchImpl, query: BEGIN_ITEMS, variables: { id: orderId } });
  const b = begun?.data?.orderEditBegin;
  if ((b?.userErrors ?? []).length || !b?.calculatedOrder?.id) return { ok: false, reason: 'edit_begin_failed' };
  const calcId = b.calculatedOrder.id;
  const subtotalBeforeCents = money2(b.calculatedOrder.subtotalPriceSet);
  if (subtotalBeforeCents === null) return { ok: false, reason: 'edit_unreadable' };

  // Unpaid add-ons from an earlier choice: their calculated lines, by id.
  const calcLines = b.calculatedOrder.lineItems?.nodes ?? [];
  const removeIds = [];
  for (const id of removeLineItemIds) {
    const l = calcLines.find((c) => tail(c.id) === tail(id));
    if (!l) return { ok: false, reason: 'addon_line_not_found' };
    if (l.quantity > 0) removeIds.push(l.id);
  }

  let calc = { subtotal: subtotalBeforeCents, total: money2(b.calculatedOrder.totalPriceSet), outstanding: null };
  if (removeIds.length || addVariants.length) {
    const variables = { id: calcId };
    removeIds.forEach((id, i) => { variables[`l${i}`] = id; });
    addVariants.forEach((v, i) => { variables[`v${i}`] = v.variantId; variables[`q${i}`] = v.quantity; });
    const res = await shopifyGraphQL({
      shop, token, fetchImpl, query: itemsDocument(removeIds.length, addVariants.length), variables,
    });
    const steps = Object.values(res?.data ?? {});
    if (!steps.length || steps.some((r) => (r?.userErrors ?? []).length || !r?.calculatedOrder)) {
      return { ok: false, reason: 'addon_stage_failed' };
    }
    const last = steps[steps.length - 1].calculatedOrder;
    calc = { subtotal: money2(last.subtotalPriceSet), total: money2(last.totalPriceSet), outstanding: money2(last.totalOutstandingSet) };
    if (calc.subtotal === null || calc.total === null || calc.outstanding === null) return { ok: false, reason: 'edit_unreadable' };
  }

  // The shipping line, from checkout's rate at the NEW subtotal.
  const ship = await shippingFor(calc.subtotal, b.calculatedOrder);
  if (ship?.error) return { ok: false, reason: ship.error };
  if (ship) {
    if (!Number.isSafeInteger(ship.priceCents) || ship.priceCents < 0) return { ok: false, reason: 'bad_price' };
    const line = (b.calculatedOrder.shippingLines ?? []).find((l) => tail(l.id) === tail(ship.removeLineId));
    if (!line) return { ok: false, reason: 'shipping_line_not_found' };
    const staged = await shopifyGraphQL({
      shop, token, fetchImpl, query: SHIP_STAGE,
      variables: { id: calcId, remove: line.id, add: { title: ship.title, price: { amount: centsToAmount(ship.priceCents), currencyCode: 'USD' } } },
    });
    const r = staged?.data;
    if ((r?.removed?.userErrors ?? []).length || (r?.added?.userErrors ?? []).length || !r?.added?.calculatedOrder) {
      return { ok: false, reason: 'edit_stage_failed' };
    }
    const c = r.added.calculatedOrder;
    calc = { subtotal: money2(c.subtotalPriceSet), total: money2(c.totalPriceSet), outstanding: money2(c.totalOutstandingSet) };
    if (calc.subtotal === null || calc.total === null || calc.outstanding === null) return { ok: false, reason: 'edit_unreadable' };
  }
  if (calc.outstanding === null) return { ok: false, reason: 'nothing_to_change' };
  if (Number.isSafeInteger(totalBeforeCents) && calc.total - totalBeforeCents !== calc.outstanding) {
    return { ok: false, reason: 'edit_inconsistent' };
  }
  return {
    ok: true, calculatedOrderId: calcId, subtotalBeforeCents, subtotalCents: calc.subtotal,
    outstandingCents: calc.outstanding, totalCents: calc.total, shipping: ship ?? null,
  };
}

/**
 * Commit a staged edit. SHOPIFY_WRITES only. The customer is not notified by
 * the edit itself; they are redirected to Shopify's payment page for the
 * balance (paymentUrl), and the invoice email is only a fallback.
 */
export async function commitShippingChange({ shop, token, orderName, calculatedOrderId, staffNote, fetchImpl }) {
  const blocked = blockedReason(orderName, shopifyWritesEnabled);
  if (blocked) return { committed: false, ...blocked };
  const res = await shopifyGraphQL({
    shop, token, fetchImpl, write: true, query: COMMIT, variables: { id: calculatedOrderId, note: staffNote },
  });
  const r = res?.data?.orderEditCommit;
  if ((r?.userErrors ?? []).length || !r?.order) return { committed: false, error: 'commit_failed', userErrors: r?.userErrors };
  return {
    committed: true,
    financialStatus: r.order.displayFinancialStatus,
    outstandingCents: toCents(r.order.totalOutstandingSet?.shopMoney?.amount),
    totalCents: toCents(r.order.currentTotalPriceSet?.shopMoney?.amount),
    // Shopify's own page for paying the balance — the same checkout the
    // customer used to buy. The customer is sent straight there.
    paymentUrl: r.order.paymentCollectionDetails?.additionalPaymentCollectionUrl ?? null,
    // Every line on the order now, so the caller can tell which ones this edit added.
    lineItems: (r.order.lineItems?.nodes ?? []).map((l) => ({ id: l.id, quantity: l.currentQuantity })),
  };
}

/** Email the invoice for the outstanding balance. SHOPIFY_WRITES only. */
export async function sendBalanceInvoice({ shop, token, orderName, orderId, to, customMessage, fetchImpl }) {
  const blocked = blockedReason(orderName, shopifyWritesEnabled);
  if (blocked) return { sent: false, ...blocked };
  const email = { ...(to ? { to } : {}), ...(customMessage ? { customMessage } : {}) };
  const res = await shopifyGraphQL({
    shop, token, fetchImpl, write: true, query: INVOICE,
    variables: { id: orderId, ...(Object.keys(email).length ? { email } : {}) },
  });
  const r = res?.data?.orderInvoiceSend;
  if ((r?.userErrors ?? []).length) return { sent: false, error: 'invoice_failed', userErrors: r.userErrors };
  return { sent: true };
}

const ORDER_NAMES = `
  query OrderNames($id: ID!) {
    order(id: $id) {
      shippingAddress { firstName lastName company phone }
      billingAddress { firstName lastName company phone }
      customer { firstName lastName phone }
    }
  }
`;

const SET_SHIPPING_ADDRESS = `
  mutation SetShippingAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id shippingAddress { address1 city provinceCode zip countryCodeV2 } }
      userErrors { field message }
    }
  }
`;

/**
 * Put the delivery address the customer typed on a pickup order, so the order
 * edit that follows taxes the shipping where it will be delivered (Shopify
 * taxes an order at its shipping address). The customer's name, company and
 * phone are kept from the order. SHOPIFY_WRITES only.
 *
 * @param {{ address1: string, address2?: string, city: string, province: string, zip: string, country?: string }} p.address
 * @returns {Promise<{ updated: boolean, skipped?: string, error?: string }>}
 */
export async function setOrderShippingAddress({ shop, token, orderName, orderId, address, fetchImpl }) {
  const blocked = blockedReason(orderName, shopifyWritesEnabled);
  if (blocked) return { updated: false, ...blocked };
  try {
    return await putShippingAddress({ shop, token, orderId, address, fetchImpl });
  } catch (err) {
    // A refusal or a network failure is an answer the caller can show, not a crash.
    return { updated: false, error: 'address_update_failed', detail: String(err?.message ?? err) };
  }
}

async function putShippingAddress({ shop, token, orderId, address, fetchImpl }) {
  const names = (await shopifyGraphQL({ shop, token, fetchImpl, query: ORDER_NAMES, variables: { id: orderId } }))?.data?.order;
  const who = names?.shippingAddress ?? names?.billingAddress ?? names?.customer ?? {};
  const input = {
    id: orderId,
    shippingAddress: {
      ...(who.firstName ? { firstName: who.firstName } : {}),
      ...(who.lastName ? { lastName: who.lastName } : {}),
      ...(who.company ? { company: who.company } : {}),
      ...(who.phone ? { phone: who.phone } : {}),
      address1: address.address1,
      ...(address.address2 ? { address2: address.address2 } : {}),
      city: address.city,
      provinceCode: address.province,
      zip: address.zip,
      countryCode: address.country || 'US',
    },
  };
  const res = await shopifyGraphQL({ shop, token, fetchImpl, write: true, query: SET_SHIPPING_ADDRESS, variables: { input } });
  const r = res?.data?.orderUpdate;
  if ((r?.userErrors ?? []).length || !r?.order) return { updated: false, error: 'address_update_failed', userErrors: r?.userErrors };
  return { updated: true };
}
