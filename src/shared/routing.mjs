// Facility routing.
//
// Decides which production facility an order goes to, and how its finished
// files are transported there. The legacy system stored zip dictionaries in
// Redis (dict:nvZipCodes, dict:caZipCodes); those are now bundled from
// zipRouting.mjs (extracted from the legacy zip.xlsx). Editing zips = edit that
// file + redeploy. Facilities: GA, NJ, TX, NV, CA. CA ships via Google Drive;
// the rest via FTP.

import { NV_ZIPS, CA_ZIPS } from './zipRouting.mjs';

/** @typedef {'GA'|'NJ'|'TX'|'NV'|'CA'} Facility */

const GDRIVE_FACILITIES = new Set(['CA']);

// Built once per Lambda cold start.
const DEFAULT_NV = new Set(NV_ZIPS);
const DEFAULT_CA = new Set(CA_ZIPS);

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
 * NV is checked BEFORE CA: NV_ZIPS are the CA destinations the NV facility
 * ships in 1 day, so they take precedence over the broader CA list. GA/NJ/TX
 * use a (still-to-be-defined) state rule; until then those orders are UNROUTED
 * (held for manual assignment) rather than shipped to the wrong facility.
 *
 * @param {{ state?: string, postalCode?: string }} shipping
 * @param {{ nvZips?: Set<string>, caZips?: Set<string> }} [dicts]
 * @returns {{ facility: Facility | 'UNROUTED', transport: 'FTP'|'GDRIVE'|null }}
 */
export function routeOrder(shipping, dicts = {}) {
  const zip = normalizeZip(shipping?.postalCode);
  const nvZips = dicts.nvZips ?? DEFAULT_NV;
  const caZips = dicts.caZips ?? DEFAULT_CA;

  if (nvZips.has(zip)) return decided('NV');
  if (caZips.has(zip)) return decided('CA');

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
