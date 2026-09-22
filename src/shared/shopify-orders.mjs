// The Shopify reads this feature needs. Two of them.
//
// Both are queries. Nothing here writes, and the transport refuses a mutation
// that is not calculate-only, so an accidental orderUpdate cannot leave here.

import { shopifyGraphQL } from './shopify-fetch.mjs';

/**
 * The order-status URL is the whole of the customer page's access control: the
 * link in the confirmation email carries it, and we compare what arrives
 * against what we stored (order-token.mjs). It lives only in Shopify — the
 * OrderDesk copy of an order does not carry it — so it has to be read from here.
 *
 * Looked up by order NAME (S59131), which is what OrderDesk calls source_id and
 * what our rows are keyed on.
 */
const ORDER_BY_NAME = `
  query OrderStatusUrl($q: String!) {
    orders(first: 2, query: $q) {
      nodes {
        id
        name
        statusPageUrl
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

/**
 * Find one order by its name and return what the customer page needs.
 *
 * Asks for TWO and refuses if both come back. Shopify's `query:` is a search,
 * not an exact match, so a name that is a prefix of another ("S5913" matching
 * "S59131") could return the wrong order — and this feeds an access check.
 * Ambiguity has to fail, not pick one.
 *
 * @returns {Promise<null | { id: string, name: string, statusPageUrl: string,
 *                            subtotal: number|null }>}
 */
export async function fetchOrderByName({ shop, token, orderName, fetchImpl }) {
  const name = String(orderName ?? '').trim();
  if (!name) return null;

  const payload = await shopifyGraphQL({
    shop, token, fetchImpl,
    query: ORDER_BY_NAME,
    // Quoted so the whole name is one term rather than being split on the dash
    // in names like S23766-2-M.
    variables: { q: `name:"${name.replace(/"/g, '')}"` },
  });

  const nodes = payload?.data?.orders?.nodes ?? [];
  const exact = nodes.filter((n) => n?.name === name || n?.name === `#${name}`);

  if (exact.length !== 1) {
    console.warn(JSON.stringify({
      msg: exact.length === 0 ? 'Shopify: order not found' : 'Shopify: ambiguous order name',
      orderName: name, matched: exact.length,
    }));
    return null;
  }

  const o = exact[0];
  const subtotal = Number(o?.currentSubtotalPriceSet?.shopMoney?.amount);
  return {
    id: o.id,
    name: o.name,
    statusPageUrl: o.statusPageUrl ?? null,
    subtotal: Number.isFinite(subtotal) ? subtotal : null,
  };
}

/**
 * What Shopify would actually charge for the upgrade, tax included.
 *
 * draftOrderCalculate prices a draft without creating one — no draft, no order,
 * no invoice, nothing persisted. It is the only honest source for the tax: the
 * rate depends on the destination, and a figure we worked out ourselves could
 * differ from the money that actually moves.
 *
 * Returns null rather than a guess if Shopify cannot price it. The page shows
 * no amount in that case.
 */
const CALCULATE = `
  mutation UpgradeQuote($input: DraftOrderInput!) {
    draftOrderCalculate(input: $input) {
      calculatedDraftOrder {
        subtotalPriceSet { shopMoney { amount } }
        totalTaxSet { shopMoney { amount } }
        totalPriceSet { shopMoney { amount } }
      }
      userErrors { field message }
    }
  }
`;

/**
 * @param {object} p
 * @param {string} p.title      the invoice line, e.g. "Shipping Upgrade: 2-Days -> 1-Day"
 * @param {number} p.amount     the shipping difference, before tax
 * @param {string} p.customerId Shopify customer gid, so the tax uses their address
 * @returns {Promise<null | { subtotal: number, tax: number, total: number }>}
 */
export async function quoteUpgradeWithTax({
  shop, token, title, amount, customerId, shippingAddress, fetchImpl,
}) {
  if (!(Number(amount) > 0)) return null;

  const input = {
    lineItems: [{
      title,
      originalUnitPrice: Number(amount).toFixed(2),
      quantity: 1,
      requiresShipping: false,
      taxable: true,
    }],
    ...(customerId ? { purchasingEntity: { customerId } } : {}),
    ...(shippingAddress ? { shippingAddress } : {}),
  };

  const payload = await shopifyGraphQL({
    shop, token, fetchImpl, query: CALCULATE, variables: { input },
  });

  const result = payload?.data?.draftOrderCalculate;
  const errs = result?.userErrors ?? [];
  if (errs.length > 0) {
    console.warn(JSON.stringify({ msg: 'Shopify could not price the upgrade', errs }));
    return null;
  }

  const calc = result?.calculatedDraftOrder;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const subtotal = num(calc?.subtotalPriceSet?.shopMoney?.amount);
  const tax = num(calc?.totalTaxSet?.shopMoney?.amount);
  const total = num(calc?.totalPriceSet?.shopMoney?.amount);

  // All three or nothing. A partial answer is how a customer gets quoted a
  // number that is missing its tax.
  if (subtotal === null || tax === null || total === null) return null;
  return { subtotal, tax, total };
}
