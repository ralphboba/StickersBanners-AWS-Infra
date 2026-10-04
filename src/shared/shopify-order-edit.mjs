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
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) return { ok: false, reason: 'bad_price' };
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
