// The customer's view of their own order. READ ONLY.
//
//   GET /my-order?o=<order name>&s=<url-encoded Shopify order_status_url>
//
// Nothing here writes, charges, or moves anything. It answers two questions:
// where is my order, and may I still upgrade the shipping — and for the second
// it quotes the exact difference the invoice would be for.
//
// ── what it refuses to say ─────────────────────────────────────────────────
// Order numbers are sequential, so the name alone proves nothing; the token in
// the link is what authorises. A wrong token and a non-existent order return
// the SAME 404, because "that order exists but you may not see it" is itself
// something worth hiding.
//
// Internal vocabulary never crosses this boundary. No folder names, no folder
// ids, no facility, no gate reasons — order-stage.mjs hands over a customer
// label and this only ever forwards that.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

import { orderStage, STEPS } from '../../shared/order-stage.mjs';
import { authorisesOrder } from '../../shared/order-token.mjs';
import { quoteUpgrade } from '../../shared/fedex-rates.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;

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
};

export async function handler(event = {}) {
  const q = event?.queryStringParameters ?? {};
  const orderName = String(q.o ?? '').trim();
  const presentedUrl = String(q.s ?? '').trim();

  if (!orderName || !presentedUrl) return json(400, { error: 'missing_parameters' });

  let row;
  try {
    const res = await ddb.send(new GetCommand({
      TableName: JOBS_TABLE,
      Key: { PK: `ORDER#${orderName}`, SK: 'META' },
    }));
    row = res?.Item;
  } catch (err) {
    console.error(JSON.stringify({ msg: 'order lookup failed', orderName, err: String(err) }));
    return json(502, { error: 'lookup_failed' });
  }

  if (!row) return NOT_FOUND;

  // The token is captured at intake. Until that is wired, no order authorises,
  // which is the correct direction to fail.
  if (!row.orderStatusUrl || !authorisesOrder(presentedUrl, row.orderStatusUrl)) {
    console.warn(JSON.stringify({ msg: 'order status access refused', orderName }));
    return NOT_FOUND;
  }

  const currentMethod = row.shipping?.method ?? null;
  const stage = orderStage({ folderId: row.folderId, shippingMethod: currentMethod });

  // ── the quote ─────────────────────────────────────────────────────────
  // The rate card gives the shipping difference. It does NOT give the tax:
  // whether shipping is taxable, and at what rate, depends on the destination,
  // and a figure we invented here would differ from the money Shopify actually
  // takes. The customer must be shown the number they will be billed, so the
  // tax comes from Shopify (draftOrderCalculate, which prices a draft order
  // without creating one) and `total` is only final once it has answered.
  //
  // Until that call is wired, `final` is false and the page will not offer a
  // price. Showing "+$33.96" and billing $36.68 is the phone call this feature
  // exists to prevent.
  let upgrade = null;
  if (stage.canUpgrade) {
    const quote = quoteUpgrade(row.totals?.subtotal, stage.currentService, stage.upgradeTo);
    if (quote) {
      const tax = null;   // ← Shopify draftOrderCalculate
      upgrade = {
        to: quote.to,
        shipping: quote.amount,
        tax,
        total: tax === null ? null : Math.round((quote.amount + tax) * 100) / 100,
        final: tax !== null,
        currentPrice: quote.fromPrice,
        newPrice: quote.toPrice,
      };
    }
  }

  return json(200, {
    orderName: row.orderName,
    stage: { label: stage.label, step: stage.step, steps: STEPS },
    shipping: {
      current: stage.currentService ?? currentMethod,
      // Both must hold: the stage allows it and we could price it. An order we
      // cannot quote is not offered an upgrade we would then fail to invoice.
      canUpgrade: Boolean(upgrade),
      reason: upgrade ? null : (BLOCKED_COPY[stage.blockedBy] ?? BLOCKED_COPY.unknown_folder),
      upgrade,
    },
    addOns: [], // pending the item and price list
  });
}
