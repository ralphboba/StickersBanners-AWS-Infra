// Admin API access token for our own Shopify app ("Manage My Order Button").
//
// Apps made in the Dev Dashboard have no permanent token to copy. They have a
// Client ID and a Client secret, and an app installed on a store owned by the
// same organisation trades those for an access token (client credentials
// grant) that lasts about 24 hours. So this module fetches one, keeps it in
// memory, and fetches a fresh one shortly before it runs out.
//
// SSM (never logged, never committed):
//   /sb/<env>/shopify/shop-domain    stickersbanners.myshopify.com
//   /sb/<env>/shopify/client-id
//   /sb/<env>/shopify/client-secret  also the key Shopify signs this app's
//                                    webhooks with (shopify-paid)
//   /sb/<env>/shopify/admin-token    optional: a legacy static token, used
//                                    only when client-id is absent

/** Fetch a new token this long before the old one expires. */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

const missing = (err) => err?.name === 'ParameterNotFound';

/**
 * @param {{ getSecret: (group: string, key: string) => Promise<string>,
 *           fetchImpl?: typeof fetch, now?: () => number }} deps
 * @returns {() => Promise<{ shop: string, token: string }>}
 */
export function makeShopifyCredentials({ getSecret, fetchImpl, now = Date.now }) {
  let held = null;      // { shop, token, expiresAt }
  let inFlight = null;  // one exchange at a time, however many callers

  async function exchange() {
    const shop = await getSecret('shopify', 'shop-domain');
    let clientId;
    try { clientId = await getSecret('shopify', 'client-id'); } catch (err) {
      if (!missing(err)) throw err;
      // No app credentials: fall back to a static token if one is stored.
      return { shop, token: await getSecret('shopify', 'admin-token'), expiresAt: Infinity };
    }
    const clientSecret = await getSecret('shopify', 'client-secret');

    const res = await (fetchImpl ?? fetch)(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
      }).toString(),
    });
    // The body may echo nothing secret, but it is not logged either way.
    if (!res.ok) throw new Error(`shopify token exchange failed: HTTP ${res.status}`);
    const body = await res.json();
    const token = body?.access_token;
    const expiresIn = Number(body?.expires_in);
    if (typeof token !== 'string' || !token) throw new Error('shopify token exchange returned no token');
    return {
      shop, token,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : now() + 60 * 60 * 1000,
    };
  }

  return async function credentials() {
    if (held && held.expiresAt - REFRESH_MARGIN_MS > now()) return { shop: held.shop, token: held.token };
    if (!inFlight) {
      inFlight = exchange().then((c) => { held = c; return c; }).finally(() => { inFlight = null; });
    }
    const c = await inFlight;
    return { shop: c.shop, token: c.token };
  };
}
