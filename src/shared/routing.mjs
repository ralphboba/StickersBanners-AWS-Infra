// Facility routing.
//
// Decides which production facility an order goes to, and how its finished
// files are transported there. The legacy system stored zip dictionaries in
// Redis (dict:nvZipCodes, dict:caZipCodes); those are now bundled from
// zipRouting.mjs (extracted from the legacy zip.xlsx). Editing zips = edit that
// file + redeploy. Facilities: GA, NJ, TX, NV, CA. CA ships via Google Drive;
// the rest via FTP.

import { NV_ZIPS } from './zipRouting.mjs';

/** @typedef {'GA'|'NJ'|'TX'|'NV'|'CA'} Facility */

const GDRIVE_FACILITIES = new Set(['CA']);

// Built once per Lambda cold start.
const DEFAULT_NV = new Set(NV_ZIPS);

// State -> facility (Linh's rule). NV/CA are decided by ZIP first (NV ships some
// CA-destination zips); every other state ships from the facility listed here.
const GA_STATES = new Set(['AL', 'FL', 'GA', 'IN', 'KY', 'MI', 'MS', 'NC', 'SC', 'TN', 'WI', 'OH', 'WV', 'VA']);
const NJ_STATES = new Set(['CT', 'DC', 'DE', 'MA', 'ME', 'NH', 'NJ', 'NY', 'RI', 'VT', 'MD', 'PA']);
const TX_STATES = new Set(['AR', 'CO', 'IL', 'IA', 'KS', 'LA', 'MO', 'ND', 'NE', 'NM', 'OK', 'SD', 'TX', 'WY', 'MN']);
const NV_STATES = new Set(['WA', 'OR', 'NV', 'AZ', 'UT', 'ID', 'MT']);

/**
 * Resolve the transport for a facility.
 * @param {Facility} facility
 * @returns {'FTP'|'GDRIVE'}
 */
export function transportFor(facility) {
  return GDRIVE_FACILITIES.has(facility) ? 'GDRIVE' : 'FTP';
}

/**
 * Decide the facility for an order from its shipping state + postal code.
 *
 * Linh's rule: "Zip code check only applies to nv/ca cause nv ships to some zip
 * codes in ca. The rest of the production ships by state." So the ZIP lookup is
 * gated on the shipping state being CA — only a CA-bound order can be pulled to
 * the NV facility by ZIP; everything else routes purely by state.
 *
 *   - state === CA: NV_ZIPS (NV-shipped CA destinations) → else CA.
 *   - other states: GA/NJ/TX/NV state lists.
 * Anything still unmatched is UNROUTED (held for manual assignment).
 *
 * @param {{ state?: string, postalCode?: string }} shipping
 * @param {{ nvZips?: Set<string> }} [dicts]
 * @returns {{ facility: Facility | 'UNROUTED', transport: 'FTP'|'GDRIVE'|null }}
 */
export function routeOrder(shipping, dicts = {}) {
  const state = String(shipping?.state ?? '').trim().toUpperCase();

  // ZIP routing applies ONLY to CA-bound orders (NV ships some CA zips in 1 day).
  if (state === 'CA') {
    const zip = normalizeZip(shipping?.postalCode);
    const nvZips = dicts.nvZips ?? DEFAULT_NV;
    if (nvZips.has(zip)) return decided('NV');
    return decided('CA');
  }

  if (GA_STATES.has(state)) return decided('GA');
  if (NJ_STATES.has(state)) return decided('NJ');
  if (TX_STATES.has(state)) return decided('TX');
  if (NV_STATES.has(state)) return decided('NV');

  return { facility: 'UNROUTED', transport: null, pickupStatus: null };
}

/** Facility -> full routing decision incl. the "Awaiting Pickup (XX)" folder key. */
function decided(facility) {
  return {
    facility,
    transport: transportFor(facility),
    pickupStatus: `pickup_${facility.toLowerCase()}`,
  };
}

/** ZIP+4 and stray whitespace -> the 5-digit base used by the dictionaries. */
function normalizeZip(postalCode) {
  const m = String(postalCode ?? '').trim().match(/^(\d{5})/);
  return m ? m[1] : '';
}
