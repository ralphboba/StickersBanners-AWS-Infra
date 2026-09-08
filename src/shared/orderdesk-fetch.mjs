// Every OrderDesk HTTP call goes through here.
//
// Ported from legacy orderDeskWithRetry (queueHelpers.mjs): OrderDesk rate
// limits with 429 and tells you how long to wait, and legacy retries up to five
// times honouring that header. Nothing here did, so a single 429 threw and lost
// the whole poll — and the mirror alone makes ~10 paged calls a minute.
//
// One deliberate difference: legacy ran on a PC with no deadline and would
// happily sleep 5 x 30s. A Lambda has a hard timeout, so the retries share a
// wall-clock budget and give up early rather than being killed mid-sleep.
// Giving up is safe: polling is idempotent, so the next scheduled run re-reads
// whatever was missed.

export const ORDERDESK_API = 'https://app.orderdesk.me/api/v2';

/** Legacy default when the header is absent. */
const DEFAULT_RETRY_AFTER_S = 30;
/** Never sleep longer than this for one attempt, whatever the header claims. */
const MAX_RETRY_AFTER_S = 60;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * How long OrderDesk asked us to wait, in ms.
 * Legacy reads `X-Retry-After`; the standard spelling is `Retry-After`. Accept
 * either, fall back to 30s, and clamp so a bad header cannot stall the function.
 */
export function retryAfterMs(res) {
  const raw = res?.headers?.get?.('retry-after') ?? res?.headers?.get?.('x-retry-after');
  const seconds = Number(raw);
  const use = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S;
  return Math.min(use, MAX_RETRY_AFTER_S) * 1000;
}

/** Build request headers for the store. */
export function orderDeskHeaders(storeId, apiKey, extra = {}) {
  return {
    'ORDERDESK-STORE-ID': storeId,
    'ORDERDESK-API-KEY': apiKey,
    ...extra,
  };
}

/**
 * fetch() with OrderDesk's rate limit handled.
 *
 * Only 429 is retried — same as legacy, which rethrows everything else. A 4xx
 * or 5xx comes back to the caller untouched so existing error handling still
 * sees it.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ maxAttempts?: number, budgetMs?: number,
 *           sleep?: (ms: number) => Promise<void>,
 *           fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Response>}
 */
export async function orderDeskFetch(url, init = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5; // legacy maxRetries
  const budgetMs = opts.budgetMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();

  for (let attempt = 1; ; attempt += 1) {
    const res = await doFetch(url, init);
    if (res.status !== 429) return res;

    if (attempt >= maxAttempts) {
      throw new Error(`OrderDesk rate limited: gave up after ${attempt} attempts`);
    }
    const waitMs = retryAfterMs(res);
    const elapsed = Date.now() - startedAt;
    if (elapsed + waitMs > budgetMs) {
      throw new Error(
        `OrderDesk rate limited: ${Math.round(waitMs / 1000)}s wait exceeds the `
        + `${Math.round(budgetMs / 1000)}s retry budget (attempt ${attempt})`,
      );
    }
    console.warn(JSON.stringify({
      msg: 'OrderDesk rate limited, retrying',
      attempt, waitMs, url: String(url).split('?')[0],
    }));
    await sleep(waitMs);
  }
}
