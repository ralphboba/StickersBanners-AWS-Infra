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

import { fetchOrderForPricing, quoteShippingChange, deliveryEstimates } from '../../shared/shopify-pricing.mjs';
import { getSecret } from '../../shared/secrets.mjs';
import { makeShopifyCredentials } from '../../shared/shopify-auth.mjs';
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

const shopifyCreds = makeShopifyCredentials({ getSecret });

// Every Shopify failure becomes "no price", never an error page and never a
// guess: a page that shows nothing is a nuisance; a number we cannot bill is
// a refund.
async function loadShopifyOrder(orderName) {
  try {
    return await fetchOrderForPricing({ ...(await shopifyCreds()), orderName });
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'Shopify order read failed', orderName, err: String(err) }));
    return null;
  }
}

async function quote(args) {
  try {
    return await quoteShippingChange({ ...(await shopifyCreds()), ...args });
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'Shopify quote failed', err: String(err) }));
    return { ok: false, reason: 'shopify_error' };
  }
}

async function estimates(args) {
  try {
    return await deliveryEstimates({ ...(await shopifyCreds()), ...args });
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'Shopify estimates failed', err: String(err) }));
    return null;
  }
}

export const handler = makeHandler({ loadRow, loadShopifyOrder, quote, estimates });
