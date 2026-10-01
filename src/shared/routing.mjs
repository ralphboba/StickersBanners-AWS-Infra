// Facility routing.
//
// Decides which production facility an order goes to, and how its finished
// files are transported there. Facilities: GA, NJ, TX, NV, CA. CA ships via
// Google Drive; the rest via FTP.
//
// Routing is by shipping state, plus pickup method and the express cutoff.
// It used to also consult zip dictionaries (legacy dict:nvZipCodes /
// dict:caZipCodes, bundled here as zipRouting.mjs) to split California between
// the NV and CA facilities. Linh retired that split on 2026-09-18: CA takes
// pickup orders only, so a CA shipping address now prints in NV like any other
// NV-list state. zipRouting.mjs is left in the tree as the record of what those
// dictionaries held, but nothing reads it.

/** @typedef {'GA'|'NJ'|'TX'|'NV'|'CA'} Facility */

const GDRIVE_FACILITIES = new Set(['CA']);

// Built once per Lambda cold start.

// State -> facility, as Linh confirmed on 2026-09-18 ("that shipping state is
// correct"). Every state ships from the facility listed here; AK and HI are on
// no list and stay unrouted.
const GA_STATES = new Set(['AL', 'FL', 'GA', 'IN', 'KY', 'MI', 'MS', 'NC', 'SC', 'TN', 'WI', 'OH', 'WV', 'VA']);
const NJ_STATES = new Set(['CT', 'DC', 'DE', 'MA', 'ME', 'NH', 'NJ', 'NY', 'RI', 'VT', 'MD', 'PA']);
const TX_STATES = new Set(['AR', 'CO', 'IL', 'IA', 'KS', 'LA', 'MO', 'ND', 'NE', 'NM', 'OK', 'SD', 'TX', 'WY', 'MN']);
const NV_STATES = new Set(['WA', 'OR', 'NV', 'AZ', 'UT', 'ID', 'MT',
  // Linh, 2026-09-18: "CA only does CA pick up orders now, so orders
  // ship to CA address will be printed in NV." A CA *pickup* still goes
  // to CA -- that is decided in step 1, before any state list is read.
  'CA',
]);

/**
 * Resolve the transport for a facility.
 * @param {Facility} facility
 * @returns {'FTP'|'GDRIVE'}
 */
export function transportFor(facility) {
  return GDRIVE_FACILITIES.has(facility) ? 'GDRIVE' : 'FTP';
}

/**
 * Legacy PICKUP_LOCATION_KEYWORDS. A local-pickup order routes by where the
 * customer is collecting it, taken from the shipping METHOD text — not by the
 * shipping address. Checked before anything else.
 *
 * ⚠️ These are substring matches over an object whose keys are checked in
 * declaration order, and the two-letter entries collide with real words:
 * both the CA and NV facility cities contain "ga" — "gardena" and "vegas" —
 * so a pickup at either matches GA and ships from Georgia. Legacy has the
 * identical list and the identical order, so this port
 * reproduces it deliberately rather than quietly diverging — see the test in
 * test/shared/routing.test.mjs. Raised with Linh; do not "fix" it here until he
 * confirms, because changing it changes where real orders ship from.
 */
const PICKUP_KEYWORDS = {
  GA: ['georgia', 'duluth', 'ga'],
  NJ: ['newjersey', 'nj', 'philadelphia', 'pa', 'new york', 'new jersey'],
  TX: ['carrollton', 'tx', 'texas'],
  NV: ['lasvegas', 'nv', 'nevada'],
  CA: ['gardena', 'ca', 'california'],
};

/** Shipping speeds that get pulled to NV inside the afternoon cutoff. */
const EXPRESS_1_2_DAY = ['1-day', 'overnight', '2-day', '2day'];
/** Shipping speeds that get UPGRADED to 2-day inside the cutoff. */
const EXPRESS_3_DAY = ['3-day', 'express'];
const CUTOFF_START_HOUR = 15; // 3pm ET
const CUTOFF_END_HOUR = 18;   // 6pm ET

/** Current hour in America/New_York, the timezone legacy computes the cutoff in. */
export function easternHour(now = new Date()) {
  return parseInt(
    now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }),
    10,
  );
}

const withinCutoff = (hour) => hour >= CUTOFF_START_HOUR && hour <= CUTOFF_END_HOUR;


/**
 * Decide the facility for an order, following legacy getState +
 * determineProduction in that order:
 *
 *   1. local pickup keywords in the shipping METHOD win outright
 *      (a see-thru order may not be picked up from CA)
 *   2. between 3pm and 6pm ET: 1-day/2-day go to NV; 3-day is upgraded to
 *      2-day (returned as `expressUpgrade` for the caller to write back)
 *   3. GA/NJ/TX/NV state lists — Linh's lists, with CA on the NV list since
 *      2026-09-18
 *   4. anything left (AK, HI) is UNROUTED unless it is see-thru, which goes
 *      to NV
 *
 * Unmatched is UNROUTED, held for manual assignment rather than guessed at.
 *
 * Pure: the express upgrade is reported, never performed.
 *
 * @param {{ state?: string, postalCode?: string, method?: string }} shipping
 * @param {{ seeThru?: boolean, now?: Date }} [opts]
 * @returns {{ facility: Facility|'UNROUTED', transport: 'FTP'|'GDRIVE'|null,
 *             pickupStatus: string|null, reason?: string,
 *             expressUpgrade?: { to: string, note: string } }}
 */
export function routeOrder(shipping, opts = {}) {
  const state = String(shipping?.state ?? '').trim().toUpperCase();
  const method = String(shipping?.method ?? '').toLowerCase();
  const seeThru = Boolean(opts.seeThru);
  const hour = easternHour(opts.now);

  // 1. Local pickup wins over the address entirely.
  for (const [facility, keywords] of Object.entries(PICKUP_KEYWORDS)) {
    if (!keywords.some((k) => method.includes(k))) continue;
    // Legacy blocks a see-thru order from CA pickup (returns false = unrouted).
    if (facility === 'CA' && seeThru) return unrouted('see-thru cannot ship from CA');
    return decided(facility, `pickup: ${method}`);
  }

  // 2. Express cutoff. 1-day/2-day inside the window go to NV outright; 3-day
  //    inside the window is upgraded to 2-day and then routed normally. The
  //    upgrade writes a note back to the order, so it is returned as an intent
  //    for the caller to perform rather than done here.
  let expressUpgrade;
  if (withinCutoff(hour)) {
    if (EXPRESS_1_2_DAY.some((k) => method.includes(k))) {
      return decided('NV', `express ${method} within 3-6pm ET cutoff`);
    }
    if (EXPRESS_3_DAY.some((k) => method.includes(k))) {
      expressUpgrade = { to: '2-day Shipping', note: '3-day to 2-day after 3PM cutoff' };
    }
  }

  const withUpgrade = (r) => (expressUpgrade ? { ...r, expressUpgrade } : r);

  // 3. State lists (Linh's, as sent to Kai).
  if (GA_STATES.has(state)) return withUpgrade(decided('GA'));
  if (NJ_STATES.has(state)) return withUpgrade(decided('NJ'));
  if (TX_STATES.has(state)) return withUpgrade(decided('TX'));
  if (NV_STATES.has(state)) return withUpgrade(decided('NV'));

  // 4. Nothing is decided by ZIP any more. The NV/CA zip dictionaries existed
  //    only to split California between the two facilities, and Linh retired
  //    that split on 2026-09-18 -- CA now takes pickups only, so every CA
  //    address prints in NV and CA is simply on the NV state list above.
  //
  //    What still reaches here is AK and HI, the only states on no list.
  //    They stay UNROUTED, held for a person, exactly as before: Linh said
  //    where CA orders go, not where those go, and guessing a facility for
  //    them would put real print files on a truck to the wrong coast.
  if (seeThru) return withUpgrade(decided('NV', 'see-thru decal'));

  return withUpgrade(unrouted('no state match'));
}

function unrouted(reason) {
  return { facility: 'UNROUTED', transport: null, pickupStatus: null, reason };
}

/** Facility -> full routing decision incl. the "Awaiting Pickup (XX)" folder key. */
function decided(facility, reason) {
  return {
    facility,
    transport: transportFor(facility),
    pickupStatus: `pickup_${facility.toLowerCase()}`,
    ...(reason ? { reason } : {}),
  };
}

/** ZIP+4 and stray whitespace -> the 5-digit base used by the dictionaries. */
function normalizeZip(postalCode) {
  const m = String(postalCode ?? '').trim().match(/^(\d{5})/);
  return m ? m[1] : '';
}
