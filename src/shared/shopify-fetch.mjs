// Every Shopify Admin API call goes through here.
//
// ── keeping out of the legacy program's way ────────────────────────────────
// Linh's bot does not talk to Shopify at all, so there is no direct collision.
// The indirect one is real though: Shopify rate-limits per ACCESS TOKEN, and
// OrderDesk's Shopify integration — which is how orders reach the legacy bot in
// the first place — has a token of its own. Exhausting a shared bucket would
// slow the downloads the legacy program feeds on.
//
// So this client MUST use a dedicated custom app's token, never OrderDesk's.
// With its own token it has its own bucket, and nothing we do here can starve
// the integration. That is a setup requirement, not something code can enforce
// — see docs/legacy-collision-audit.md.
//
// What the code CAN enforce, and does:
//   · reads only. A mutation is refused unless explicitly allowed, and the
//     allowlist holds only operations that persist nothing.
//   · one request at a time. No fan-out, no parallel bursts.
//   · Shopify's own throttle numbers are read back from every response and the
//     client waits when the bucket runs low, rather than discovering the limit
//     by being rejected.

/** Admin API version. Pinned: an unpinned version changes under you. */
export const SHOPIFY_API_VERSION = '2025-07';

/**
 * Mutations that may be sent despite the read-only posture, because they
 * calculate and return without writing anything.
 *
 * draftOrderCalculate prices a draft — taxes included — and creates no draft,
 * no order and no record. It is the only way to learn what Shopify will
 * actually charge, and guessing that number is what we are avoiding.
 */
const CALCULATE_ONLY_MUTATIONS = new Set(['draftOrderCalculate']);

/** Below this many points left, wait for the bucket to refill before sending. */
const LOW_WATER_POINTS = 200;
/** Never sleep longer than this in one wait, whatever Shopify reports. */
const MAX_WAIT_MS = 10_000;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The operation name and kind of a GraphQL document, without parsing it fully. */
export function describeOperation(document) {
  const text = String(document ?? '');
  // Strip comments first so a commented-out "mutation" cannot fool either us
  // or, worse, slip a real one past a naive check.
  const stripped = text.replace(/#[^\n]*/g, '');
  const m = stripped.match(/\b(query|mutation)\b\s*([A-Za-z_][A-Za-z0-9_]*)?/);
  if (!m) return { kind: 'query', name: null };  // a bare `{ ... }` is a query
  return { kind: m[1], name: m[2] ?? null };
}

/**
 * Is this document safe to send from a read-only client?
 * Refuses anything that could persist, and says why.
 */
export function checkReadOnly(document) {
  const { kind, name } = describeOperation(document);
  if (kind !== 'mutation') return { ok: true };

  // The operation NAME is chosen by us and proves nothing; what matters is the
  // field being invoked. Look for a calculate-only field in the selection.
  const invokes = [...String(document).matchAll(/\b([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g)]
    .map((m) => m[1]);
  const allowed = invokes.some((f) => CALCULATE_ONLY_MUTATIONS.has(f));
  if (allowed) return { ok: true };

  return {
    ok: false,
    reason: `refused: mutation ${name ?? '(anonymous)'} is not a calculate-only operation`,
  };
}

/** How long to wait for the bucket, from Shopify's own throttle numbers. */
export function waitForBucket(throttleStatus) {
  const available = Number(throttleStatus?.currentlyAvailable);
  const restoreRate = Number(throttleStatus?.restoreRate);
  if (!Number.isFinite(available) || !Number.isFinite(restoreRate) || restoreRate <= 0) return 0;
  if (available >= LOW_WATER_POINTS) return 0;
  const seconds = (LOW_WATER_POINTS - available) / restoreRate;
  return Math.min(Math.ceil(seconds * 1000), MAX_WAIT_MS);
}

/** Serialises calls: the next request waits for the previous one to finish. */
let chain = Promise.resolve();
/** Set from the last response, so the NEXT call can wait before sending. */
let pendingWaitMs = 0;

/**
 * Send one GraphQL document to the Admin API.
 *
 * @param {object} p
 * @param {string} p.shop        e.g. "stickersbanners.myshopify.com"
 * @param {string} p.token       the dedicated custom app's Admin API token
 * @param {string} p.query       the GraphQL document
 * @param {object} [p.variables]
 * @param {typeof fetch} [p.fetchImpl]
 * @param {(ms:number)=>Promise<void>} [p.sleep]
 * @returns {Promise<{ data: object }>}
 */
export async function shopifyGraphQL({
  shop, token, query, variables, fetchImpl, sleep = defaultSleep,
}) {
  const gate = checkReadOnly(query);
  if (!gate.ok) throw new Error(`Shopify ${gate.reason}`);
  if (!shop || !token) throw new Error('Shopify: missing shop or token');

  const run = async () => {
    if (pendingWaitMs > 0) {
      const ms = pendingWaitMs;
      pendingWaitMs = 0;
      console.warn(JSON.stringify({ msg: 'Shopify bucket low, waiting', ms }));
      await sleep(ms);
    }

    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      // Shouldn't happen once the low-water wait is doing its job; treat it as
      // a signal to back off hard rather than retrying straight away.
      pendingWaitMs = MAX_WAIT_MS;
      throw new Error('Shopify rate limited (429)');
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`Shopify HTTP ${res.status}: ${body}`);
    }

    const payload = await res.json();
    pendingWaitMs = waitForBucket(payload?.extensions?.cost?.throttleStatus);

    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const first = payload.errors[0];
      // THROTTLED arrives as a GraphQL error with a 200 status.
      if (first?.extensions?.code === 'THROTTLED') {
        pendingWaitMs = MAX_WAIT_MS;
        throw new Error('Shopify rate limited (THROTTLED)');
      }
      throw new Error(`Shopify GraphQL: ${first?.message ?? 'unknown error'}`);
    }
    return payload;
  };

  // Queue behind whatever is already in flight, and keep the chain alive even
  // when a call fails.
  const result = chain.then(run, run);
  chain = result.then(() => undefined, () => undefined);
  return result;
}

/** Test seam: forget the serialisation state between cases. */
export function __resetShopifyClient() {
  chain = Promise.resolve();
  pendingWaitMs = 0;
}
