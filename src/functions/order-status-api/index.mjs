// The customer's view of their own order. READ ONLY.
//
//   GET  /my-order?o=<order name>&s=<url-encoded Shopify order_status_url>
//   POST /my-order/quote   { o, s, service, address }   (pickup -> delivery)
//
// Nothing here writes, charges, or moves anything. It answers: where is my
// order, may I still change the shipping, and what exactly would that cost —
// tax included, as Shopify computes it (draftOrderCalculate creates nothing).
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

import { quoteUpgradeWithTax } from '../../shared/shopify-orders.mjs';
import { getSecret } from '../../shared/secrets.mjs';
import { makeHandler } from './routes.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const JOBS_TABLE = process.env.JOBS_TABLE;

async function loadRow(orderName) {
  const res = await ddb.send(new GetCommand({
    TableName: JOBS_TABLE,
    Key: { PK: `ORDER#${orderName}`, SK: 'META' },
  }));
  return res?.Item;
}

/**
 * Ask Shopify what it would actually charge. Returns null on any problem, and
 * the caller then offers no price at all — a page that shows nothing is a
 * nuisance; a page that shows a number we cannot bill is a refund.
 */
async function priceWithTax(row, quote, title) {
  try {
    const [shop, token] = await Promise.all([
      getSecret('shopify', 'shop-domain'),
      getSecret('shopify', 'admin-token'),
    ]);
    return await quoteUpgradeWithTax({
      shop,
      token,
      title: title ?? `Shipping Upgrade: ${quote.from} → ${quote.to}`,
      amount: quote.amount,
      // Required: without an address the quote comes back null and the page
      // shows no price (shopify-orders.mjs toMailingAddress).
      shippingAddress: row.shipping,
    });
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'upgrade quote unavailable', err: String(err) }));
    return null;
  }
}

export const handler = makeHandler({ loadRow, priceWithTax });
