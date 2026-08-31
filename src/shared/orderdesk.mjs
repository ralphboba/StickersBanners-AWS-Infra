// OrderDesk order parsing (no AWS deps — unit-testable, reused by webhook/poller).
//
// Ported 1:1 from the legacy SBBotExpress QTS path
// (src/utils/queueManager/QTSOrderDetails.mjs): getUnit dimension remap,
// getFinishMode, getGrommetsCount2 / getSingleSideGrommetsCount, getFinishObj.
// The goal is byte-for-byte-equivalent finishing/resize output vs Linh's program.
//
// Line-item dimensions, finishing, and artwork live in `variation_list`;
// payment state is `payment_status` (verified against live store 784).

import { routeOrder } from './routing.mjs';

// All SKU-based rules live in one place — see src/shared/sku-config.mjs.
import { isInchSku, isNoFinishSku } from './sku-config.mjs';

/**
 * Normalize an OrderDesk finishing label to a comparison key.
 *
 * Legacy getFinishMode only stripped whitespace, but the live store's product
 * options now wrap modifiers in "&" and "( )" — e.g. "Hem & Grommets",
 * "Pole Pockets (Top Only)" — which the whitespace-only key never matched, so
 * ~half of real orders fell through to "no finishing". We strip "&" and the
 * parentheses (keeping "/", which the "No Hem / Grommets Only" key relies on)
 * so both the old and current label formats map to the same finishing.
 */
function normalizeFinish(finish) {
  return String(finish ?? '')
    .toLowerCase()
    .replace(/[&()]/g, '')
    .replace(/\s+/g, '');
}

// Finishing keys (normalized) that carry grommets → get size-based counts.
const GROMMETS_FINISHES = new Set([
  'hemgrommets',
  'hemgrommetsourstandard',
  'grommetsonly',
  'nohem/grommetsonly',
  'nohemgrommetsonly',
  'bravotabswithgrommets',
  'grommetwithbravotab',
  'grommetwithbravotabtoponly',
]);


/**
 * Legacy getUnit: pick the unit and remap certain nominal sizes to inches.
 * Mutates nothing — returns the effective { width, height, unit }.
 */
export function resolveDimensions(sku, productName, rawWidth, rawHeight) {
  let width = parseFloat(rawWidth);
  let height = parseFloat(rawHeight);
  let unit = isInchSku(sku) ? 'in' : 'ft';
  const name = String(productName ?? '').toLowerCase();

  if (!name.includes('fabric')) {
    if (width === 8 && height === 8) {
      width = 92; height = 92; unit = 'in';
    } else if ((width > 8 && height === 8) || (width === 8 && height > 8)) {
      width = width > 8 ? width * 12 : 92;
      height = height > 8 ? height * 12 : 92;
      unit = 'in';
    }
  }

  if (!name.includes('fabric') && !name.includes('adhesive') && !name.includes('decal')) {
    if (width === 4 && height === 4) {
      width = 46; height = 46; unit = 'in';
    } else if ((width > 4 && height === 4) || (width === 4 && height > 4)) {
      width = width > 4 ? width * 12 : 46;
      height = height > 4 ? height * 12 : 46;
      unit = 'in';
    }
  }

  return { width, height, unit };
}

/**
 * Legacy getFinishMode: strip ALL whitespace, lowercase, then match the exact
 * known finishing set. Returns the finishing object (no quantity/counts yet).
 */
export function getFinishMode(finish) {
  const key = normalizeFinish(finish);
  switch (key) {
    case 'polepocketstopandbottom':
    case 'pptb':
      return { specialFinishing: 'PPTB', descSuf: 'PPTB' };
    case 'polepocketstoponly':
    case 'ppto':
      return { specialFinishing: 'PPTO', descSuf: 'PPTO' };
    case 'polepocketsbottomonly':
    case 'ppbo':
      return { specialFinishing: 'PPBO', descSuf: 'PPBO' };
    case 'hemgrommets':
    case 'hemgrommetsourstandard':
    case 'bravotabswithgrommets':
    // Live store spellings for bravo-tab grommets (not in the legacy switch).
    case 'grommetwithbravotab':
    case 'grommetwithbravotabtoponly':
      return { grommets: { sides: ['top', 'left', 'right', 'bottom'] } };
    case 'nohem/grommetsonly':
    case 'nohem/grommetsonlyy':
    case 'grommetsonly':
      return { grommets: { sides: ['top', 'left', 'right', 'bottom'] }, isOnly: true, descSuf: 'GO' };
    case 'nohemnogrommets':
    case 'cutonly': // live store spelling; cut only = no image finishing (CO)
      return { descSuf: 'CO' };
    case 'hemonly':
      return { descSuf: 'HO' };
    case '14.5oz.petultra-smoothpvc':
      return { specialFinishing: 'RET' };
    default:
      return {};
  }
}

/** Legacy getSingleSideGrommetsCount: grommets along one side, by length (in). */
export function getSingleSideGrommetsCount(length) {
  if (typeof length !== 'number') throw new Error('Invalid input: length must be a number');
  if (length <= 36) return 2;
  if (length > 36 && length <= 72) return 3;
  if (length > 72 && length <= 108) return 4;
  if (length > 108 && length < 156) return 5;
  return Math.ceil(length / 30); // length >= 156
}

/** Legacy getGrommetsCount2: [widthGrommets, heightGrommets] from size (in). */
export function getGrommetsCount2(width, height, unit) {
  if (typeof width !== 'number' || typeof height !== 'number') {
    throw new Error('Invalid input: width and height must be numbers');
  }
  let tw;
  let th;
  switch (unit) {
    case 'ft': tw = width * 12; th = height * 12; break;
    case 'in': tw = width; th = height; break;
    default: throw new Error("Invalid unit: must be 'ft' or 'in'");
  }

  if ((tw < 46 && th <= 46) || (tw <= 46 && th < 46) || (tw <= 48 && th < 48) || (tw < 48 && th <= 48)) {
    if ((tw === 46 && th === 46) || (tw === 48 && th === 48)) return [3, 3];
    return [2, 2];
  }
  return [getSingleSideGrommetsCount(tw), getSingleSideGrommetsCount(th)];
}

/**
 * Legacy getFinishObj: mode + (for grommet finishes) size-based grommet counts +
 * quantity. `width/height/unit` must already be the resolved dimensions.
 */
export function getFinishObj(finish, width, height, unit, quantity) {
  const finishObj = getFinishMode(finish);
  const key = normalizeFinish(finish);
  if (GROMMETS_FINISHES.has(key) && finishObj.grommets) {
    const [widthG, heightG] = getGrommetsCount2(parseInt(width, 10), parseInt(height, 10), unit);
    finishObj.grommets.widthGrommets = widthG;
    finishObj.grommets.heightGrommets = heightG;
  }
  finishObj.quantity = quantity;
  return finishObj;
}

/** Map an OrderDesk order JSON into our cleaned "job" shape. */
export function cleanOrder(order) {
  const items = (order.order_items ?? []).map((it) => {
    const vl = it.variation_list ?? {};
    const sku = it.code ?? vl.SKU;
    const uploads = collectUploads(vl, it.metadata);
    const quantity = Number(it.quantity ?? 1);
    const finish = vl['FINISHING OPTIONS'];

    // Resolve dimensions/unit (with legacy remap) BEFORE finishing, so grommet
    // counts use the effective size — exactly as the legacy order path did.
    const { width, height, unit } = resolveDimensions(sku, it.name, vl.WIDTH, vl.HEIGHT);

    const noFinish = isNoFinishSku(sku);
    const finishingObj = noFinish ? { quantity } : getFinishObj(finish, width, height, unit, quantity);

    return {
      sku,
      name: it.name,
      quantity,
      width,
      height,
      unit,
      finishingRaw: finish,
      finishingObj,
      artworkUrl: uploads[0],
      artworkUrls: uploads,
    };
  });

  const shipping = {
    state: order.shipping?.state,
    postalCode: order.shipping?.postal_code,
    method: order.shipping_method,
    name: [order.shipping?.first_name, order.shipping?.last_name].filter(Boolean).join(' '),
  };

  const routing = routeOrder(shipping);

  return {
    orderName: String(order.source_id ?? order.id ?? ''),
    createdAt: toIso(order.date_added),
    folder: order.folder_name,
    financialStatus: order.payment_status,
    customer: { email: order.email, name: shipping.name },
    shipping,
    routing,
    needsProof: wantsProof(order),
    totals: {
      subtotal: num(order.product_total),
      grandTotal: num(order.order_total),
      currency: order.currency ?? 'USD',
    },
    items,
    source: { orderDeskId: String(order.id ?? '') },
  };
}

/**
 * Artwork links. Legacy QTS reads metadata.image1..image5; store 784 also puts
 * them in variation_list "UPLOADED FILE*". Prefer metadata (legacy), fall back
 * to the variation-list uploads. Non-empty, in order.
 */
function collectUploads(vl, metadata) {
  const fromMeta = metadata
    ? Object.entries(metadata)
        .filter(([k]) => k.includes('image') && /^[1-5]$/.test(k.slice(5)))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => v)
        .filter((v) => typeof v === 'string' && v.trim().length > 0)
    : [];
  if (fromMeta.length > 0) return fromMeta;

  return Object.keys(vl)
    .filter((k) => k.toUpperCase().startsWith('UPLOADED FILE'))
    .sort()
    .map((k) => vl[k])
    .filter((v) => typeof v === 'string' && v.trim().length > 0);
}

function wantsProof(order) {
  const parts = [order.customer_note, order.internal_note];
  for (const it of order.order_items ?? []) {
    const vl = it.variation_list ?? {};
    parts.push(vl['SPECIAL INSTRUCTIONS'], vl['PROOF'], vl['Proof Options']);
  }
  return parts.filter(Boolean).join(' ').toLowerCase().includes('proof');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toIso(v) {
  const d = v ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
