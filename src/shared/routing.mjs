// Facility routing (data-driven skeleton).
//
// Decides which production facility an order goes to, and how its finished
// files are transported there. The legacy system stored zip dictionaries in
// Redis (dict:nvZipCodes, dict:caZipCodes); here those become data loaded at
// runtime (DynamoDB DICT items, to be seeded later) so adding/changing zips is
// a data edit — no code change, no redeploy.
//
// Facilities: GA, NJ, TX, NV, CA. CA ships via Google Drive; the rest via FTP.

/** @typedef {'GA'|'NJ'|'TX'|'NV'|'CA'} Facility */

const GDRIVE_FACILITIES = new Set(['CA']);

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
 * NV/CA are driven by the seeded zip dictionaries; GA/NJ/TX use a
 * (still-to-be-defined) state-based rule. Until the dictionaries/rules are
 * seeded, this returns a safe default the pipeline can hold on.
 *
 * @param {{ state?: string, postalCode?: string }} shipping
 * @param {{ nvZips?: Set<string>, caZips?: Set<string> }} [dicts]
 * @returns {{ facility: Facility | 'UNROUTED', transport: 'FTP'|'GDRIVE'|null }}
 */
export function routeOrder(shipping, dicts = {}) {
  const zip = (shipping?.postalCode ?? '').trim();
  const { nvZips, caZips } = dicts;

  if (caZips?.has(zip)) return { facility: 'CA', transport: transportFor('CA') };
  if (nvZips?.has(zip)) return { facility: 'NV', transport: transportFor('NV') };

  // TODO(routing): GA/NJ/TX state-based rule once defined. Until then, leave
  // the order UNROUTED so it is held for manual assignment rather than
  // shipped to the wrong facility.
  return { facility: 'UNROUTED', transport: null };
}
