// Money as integer cents. Every amount that is charged, compared or written
// goes through here, so no dollar figure is ever the result of float
// arithmetic.

/**
 * Parse an amount to cents, strictly. Shopify sends decimal strings ("44.05",
 * "0.0", "382.2"); OrderDesk sends numbers. Anything that is not a plain
 * amount with at most two decimals is refused (null) rather than rounded —
 * a third decimal means we have misunderstood the field, not that we should
 * guess.
 *
 * @param {string|number|null|undefined} v
 * @returns {number|null}
 */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '') : String(v).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return sign ? -cents : cents;
}

/** Cents to the "12.34" string Shopify and OrderDesk take. */
export function centsToAmount(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error(`not a cent amount: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** Cents to a number of dollars, for JSON responses the page formats. */
export function centsToDollars(cents) {
  return Number(centsToAmount(cents));
}
