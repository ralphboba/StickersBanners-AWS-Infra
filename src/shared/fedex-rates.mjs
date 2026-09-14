// FedEx rate card — the price of each service at a given order subtotal.
//
// Generated from docs/data/fedex-shipping-rates.xlsx, which was transcribed
// from the PDF FedEx sent and read twice independently before being trusted.
// Do not hand-edit: change the workbook and regenerate, so the two cannot drift.
//
// ── what the numbers are ───────────────────────────────────────────────────
// Each row is [from, to, Ground, 3-Day, 2-Day, 1-Day, Saturday Overnight] and
// every figure is the FULL price of that service, not an upgrade fee. The band
// is chosen by the order SUBTOTAL, before taxes (Kai).
//
// Bands are [from, to) — the upper bound belongs to the next band. The source
// prints them as overlapping ("$1-37", "$37-52"), and an order at exactly $37
// has to land in exactly one of them.
//
// NEXT DAY STANDARD and NEXT DAY EARLY 8:30AM are absent on purpose: the card
// gives them as "VARIES BY LOC." and a price we cannot compute is a price we
// cannot charge.

/** @type {Array<[number, number, number, number, number, number, number]>} */
const BANDS = [
  [1, 37, 15.7, 33.08, 49.56, 89.25, 122.33],
  [37, 52, 15.7, 38.54, 58.38, 93.66, 126.74],
  [52, 74, 15.7, 44.05, 69.41, 100.28, 133.35],
  [74, 98, 15.7, 48.45, 76.81, 113.01, 146.09],
  [98.01, 119, 20.95, 53.54, 83.97, 126.74, 159.81],
  [119, 134, 25.15, 77.91, 118.19, 148.79, 181.86],
  [134, 194, 25.67, 86.73, 128.11, 162.07, 195.14],
  [194, 238, 26.2, 92.83, 139.14, 192.06, 225.13],
  [238, 246, 27.25, 96.47, 144.24, 199.36, 232.44],
  [246, 300, 29.35, 114.66, 169.79, 235.94, 269.01],
  [300, 343, 31.45, 132.86, 195.33, 272.51, 305.58],
  [343, 395, 33.55, 151.04, 220.87, 309.07, 342.14],
  [395, 447, 36.7, 169.24, 246.41, 345.64, 378.71],
  [447, 521, 43, 187.43, 271.95, 382.2, 415.28],
  [522, 596, 47.2, 223.81, 323.03, 455.33, 488.41],
  [596, 700, 52.45, 260.19, 374.12, 528.47, 561.54],
  [700, 790, 61.9, 296.57, 425.2, 601.6, 634.67],
  [790, 894, 71.35, 332.96, 476.28, 674.73, 707.81],
  [894, 968, 80.8, 369.34, 527.36, 747.86, 870.94],
  [968, 1117, 90.25, 405.72, 578.45, 821, 854.07],
  [1117, 1266, 109.15, 478.49, 680.61, 967.29, 1000.34],
  [1266, 1490, 128.05, 551.25, 782.78, 1113.53, 1146.6],
  [1490, 1684, 146.95, 624.02, 884.94, 1259.79, 1292.87],
  [1684, 1877, 165.85, 696.78, 987.11, 1406.06, 1439.13],
  [1877, 2086, 184.75, 769.55, 1089.27, 1552.32, 1585.4],
  [2086, 2280, 203.65, 842.31, 1191.44, 1698.59, 1731.66],
  [2280, 2459, 215.2, 915.08, 1293.6, 1844.85, 1877.93],
  [2459, 2980, 234.68, 1096.99, 1549.01, 2210.51, 2243.59],
  [2980, 3874, 254.63, 1460.81, 2059.84, 2941.84, 2974.91],
  [3874, 4960, 304.5, 1824.64, 2570.66, 3673.16, 3706.24],
  [4960, 6945, 404.25, 2552.29, 3592.31, 5135.81, 5168.89],
  [6945, 8940, 504, 3279.94, 4613.96, 6598.46, 6631.54],
  [8940, 9685, 703.5, 3643.76, 5124.79, 7329.79, 7362.86],
  [9685, 99999, 903, 3825.68, 5461.79, 7678.91, 7711.99],];

/**
 * Column index in a band row, by service.
 *
 * Keyed by several spellings on purpose: the card names the columns one way,
 * OrderDesk holds another ("FedEx 1-Day", observed on S60338), and legacy
 * writes a third ("2-day Shipping"). Pricing must work whichever reaches it.
 */
const COLUMN = {
  'ground': 2, 'fedex ground': 2,
  '3-day': 3, 'fedex 3-day': 3, '3-day shipping': 3,
  '2-day': 4, 'fedex 2-day': 4, '2-day shipping': 4,
  '1-day': 5, 'fedex 1-day': 5, '1-day shipping': 5, '1-day economical': 5,
  'saturday overnight': 6, 'sat-overnight rush': 6,
};

/** Money in cents, so differences do not drift. */
const cents = (v) => Math.round(Number(v) * 100);

/**
 * The band a subtotal falls in.
 *
 * Chosen by the LAST band whose floor the subtotal reaches, not by testing
 * from/to as a closed range. The card is not perfectly contiguous — it prints
 * "$74-98" and then "$98.01-119", leaving a sliver at $98.005 that belongs to
 * no band. Reading floors only removes every such gap, and the boundaries come
 * out the same everywhere else.
 *
 * Below the first floor falls back to the first band: an order under $1 still
 * ships. Above the last ceiling returns null rather than guessing — at that
 * size somebody quotes it by hand.
 *
 * @param {number|string} subtotal  order subtotal before taxes
 */
export function bandFor(subtotal) {
  // Number(null) is 0 and Number('') is 0, either of which would quietly price
  // a missing subtotal as the cheapest band. Demand something numeric first.
  if (subtotal === null || subtotal === undefined || subtotal === '') return null;
  if (typeof subtotal !== 'number' && typeof subtotal !== 'string') return null;
  const s = Number(subtotal);
  if (!Number.isFinite(s)) return null;

  if (s < BANDS[0][0]) return BANDS[0];
  if (s >= BANDS.at(-1)[1]) return null;

  let found = null;
  for (const band of BANDS) {
    if (s >= band[0]) found = band; else break;
  }
  return found;
}

/**
 * Full price of one service at this subtotal, or null if it cannot be priced.
 * @param {number} subtotal
 * @param {string} service  a key of COLUMN, matched case-insensitively
 */
export function priceOf(subtotal, service) {
  const key = String(service ?? '').trim().toLowerCase();
  if (!(key in COLUMN)) return null;
  const band = bandFor(subtotal);
  return band ? band[COLUMN[key]] : null;
}

/**
 * What the customer pays to move from one service to another.
 *
 * The DIFFERENCE, not the new price — they already paid for what they have
 * (Kai: "추가요금으로 붙어야 되는 거 알지?").
 *
 * Returns null when either service cannot be priced, and refuses a difference
 * that is zero or negative: a downgrade is not something this sells, and
 * charging $0 would send an invoice for nothing.
 *
 * @param {number} subtotal
 * @param {string} from  current service
 * @param {string} to    the service being bought
 * @returns {{ from: string, to: string, fromPrice: number, toPrice: number,
 *             amount: number, band: [number, number] } | null}
 */
export function quoteUpgrade(subtotal, from, to) {
  const fromPrice = priceOf(subtotal, from);
  const toPrice = priceOf(subtotal, to);
  if (fromPrice === null || toPrice === null) return null;

  const amountCents = cents(toPrice) - cents(fromPrice);
  if (amountCents <= 0) return null;

  const band = bandFor(subtotal);
  return {
    from, to, fromPrice, toPrice,
    amount: amountCents / 100,
    band: [band[0], band[1]],
  };
}

/** Exposed for the tests that check the table itself. */
export const RATE_BANDS = BANDS;
