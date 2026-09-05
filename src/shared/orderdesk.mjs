// OrderDesk order parsing (no AWS deps — unit-testable, reused by webhook/poller).
//
// Ported from the legacy SBBotExpress order classes. Legacy does NOT have one
// order parser — it picks one of two by the order's source
// (src/utils/queueManager/orderHelpers.mjs):
//
//     order_metadata['First Rep'] === 'Shopify' || source_id.startsWith('S')
//         ? ShopifyDetails      <- every real store order (S56xxx) lands here
//         : QTSOrderDetails
//
// The two classes are NOT interchangeable. They differ in the inch-SKU list,
// the finishing-label normalisation, a product-name rule for retractables,
// where artwork comes from, and how a missing/multi-file line is detected.
// Both are implemented below and selected by the same rule — see orderVariant().
//
// Line-item dimensions, finishing, and artwork live in `variation_list`;
// payment state is `payment_status` (verified against live store 784).

import { routeOrder } from './routing.mjs';

// All SKU-based rules live in one place — see src/shared/sku-config.mjs.
import {
  isInchSku, isNoFinishSku, isKnownSku, fixedDimensions,
} from './sku-config.mjs';

/** @typedef {'shopify'|'qts'} Variant */

export const SHOPIFY = 'shopify';
export const QTS = 'qts';

/**
 * Legacy getOrderObject: which order class handles this order.
 * Real store orders are named S##### and take the Shopify path.
 * @returns {Variant}
 */
export function orderVariant(order) {
  if (order?.order_metadata?.['First Rep'] === 'Shopify') return SHOPIFY;
  return String(order?.source_id ?? '').startsWith('S') ? SHOPIFY : QTS;
}

// Legacy VALID_FILES_EXT — identical in both classes. Anything else is treated
// as a missing/unusable file (legacy tags the order Red and hands it to staff).
export const VALID_FILE_EXTS = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'pdf', 'ai', 'psd']);

/**
 * Legacy getFinishMode normalisation — and the two classes differ here.
 *   QTS:     finish.toLowerCase().replace(/\s+/g, '')
 *   Shopify: finish.toLowerCase().replace(/[\s&()]+/g, '')
 * The Shopify form also folds away "&" and "( )", which is why the live store's
 * "Hem & Grommets" / "Pole Pockets (Top Only)" labels only match on that path.
 * "/" is kept by both — the "No Hem / Grommets Only" key relies on it.
 */
function normalizeFinish(finish, variant) {
  const s = String(finish ?? '').toLowerCase();
  return variant === SHOPIFY ? s.replace(/[\s&()]+/g, '') : s.replace(/\s+/g, '');
}

// Finishing keys (normalized) that carry grommets → get size-based counts.
// Legacy keeps one set per class; Shopify's adds "grommetwithbravotab".
const GROMMETS_FINISHES_QTS = new Set([
  'hemgrommets',
  'hemgrommetsourstandard',
  'grommetsonly',
  'nohem/grommetsonly',
  'nohemgrommetsonly',
  'bravotabswithgrommets',
]);
const GROMMETS_FINISHES_SHOPIFY = new Set([
  ...GROMMETS_FINISHES_QTS,
  'grommetwithbravotab',
  // NOT in legacy. The live store also sells "Grommet with Bravo Tab (TOP only)",
  // which legacy matches nowhere and therefore finishes not at all. Open question
  // for Linh (docs/linh-requirements.md §4): top only, or all four sides?
  'grommetwithbravotabtoponly',
]);

const fourSides = () => ({ grommets: { sides: ['top', 'left', 'right', 'bottom'] } });

/**
 * Legacy getUnit: pick the unit and remap certain nominal sizes to inches.
 * Mutates nothing — returns the effective { width, height, unit }.
 */
export function resolveDimensions(sku, productName, rawWidth, rawHeight, variant = SHOPIFY) {
  // Fixed-size products (e.g. tents) print at a set size regardless of the
  // order's WIDTH/HEIGHT. Return those dimensions verbatim (bleed = print size).
  // Not a legacy rule — these products postdate the legacy program.
  const fixed = fixedDimensions(sku);
  if (fixed) return { ...fixed };

  let width = parseFloat(rawWidth);
  let height = parseFloat(rawHeight);
  let unit = isInchSku(sku, { shopify: variant === SHOPIFY }) ? 'in' : 'ft';
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
 * Legacy getFinishMode: normalise the label, then match the known finishing set.
 * Returns the finishing object (no quantity/counts yet).
 *
 * @param {string} finish   the raw "FINISHING OPTIONS" label
 * @param {{ variant?: Variant, productName?: string }} [opts]
 */
export function getFinishMode(finish, opts = {}) {
  const variant = opts.variant ?? SHOPIFY;
  const shopify = variant === SHOPIFY;

  // ShopifyDetails checks the PRODUCT NAME before looking at the label at all;
  // QTSOrderDetails has no such rule. This is how retractables get RET on the
  // live path (the old material-name trigger below is commented out there).
  if (shopify && String(opts.productName ?? '').toLowerCase().includes('pop up retractable')) {
    return { specialFinishing: 'RET' };
  }

  const key = normalizeFinish(finish, variant);

  // Keys that exist in only one of the two legacy classes.
  if (key === 'grommetwithbravotab') return shopify ? fourSides() : {};
  if (key === '14.5oz.petultra-smoothpvc') return shopify ? {} : { specialFinishing: 'RET' };

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
      return fourSides();
    // NOT in legacy — see GROMMETS_FINISHES_SHOPIFY. Pending Linh.
    case 'grommetwithbravotabtoponly':
      return shopify ? fourSides() : {};
    case 'nohem/grommetsonly':
    case 'nohem/grommetsonlyy':
    case 'grommetsonly':
      return { grommets: { sides: ['top', 'left', 'right', 'bottom'] }, isOnly: true, descSuf: 'GO' };
    case 'nohemnogrommets':
      return { descSuf: 'CO' };
    // NOT in legacy (neither class). Live-store spelling of "no hem, no
    // grommets"; without it a "Cut Only" order gets no CO suffix. Pending Linh.
    case 'cutonly':
      return { descSuf: 'CO' };
    case 'hemonly':
      return { descSuf: 'HO' };
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

/**
 * Legacy grommet counts from size: [widthGrommets, heightGrommets].
 * QTSOrderDetails calls this getGrommetsCount2, ShopifyDetails calls it
 * getGrommetsCount — the bodies are identical.
 */
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
 *
 * @param {{ variant?: Variant, productName?: string }} [opts]
 */
export function getFinishObj(finish, width, height, unit, quantity, opts = {}) {
  const variant = opts.variant ?? SHOPIFY;
  const finishObj = getFinishMode(finish, opts);
  const key = normalizeFinish(finish, variant);
  const grommetKeys = variant === SHOPIFY ? GROMMETS_FINISHES_SHOPIFY : GROMMETS_FINISHES_QTS;

  // The `finishObj.grommets` guard is ours. Legacy has none, so a "pop up
  // retractable" product ordered with a grommet label returns {specialFinishing:
  // 'RET'} from getFinishMode and then throws TypeError on the next line. We
  // skip the counts instead of reproducing the crash.
  if (grommetKeys.has(key) && finishObj.grommets) {
    const [widthG, heightG] = getGrommetsCount2(parseInt(width, 10), parseInt(height, 10), unit);
    finishObj.grommets.widthGrommets = widthG;
    finishObj.grommets.heightGrommets = heightG;
  }
  finishObj.quantity = quantity;
  return finishObj;
}

// --- artwork ---------------------------------------------------------------

/**
 * Legacy getExtensionFromUrl (QTS path): the extension of the `file` query
 * parameter. Returns undefined when there is no such parameter, matching legacy.
 */
function extensionFromUrl(url) {
  try {
    const fileParam = new URL(url).searchParams.get('file');
    if (fileParam) {
      const fileName = fileParam.split('/').pop();
      return fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : null;
    }
  } catch {
    return null;
  }
  return undefined;
}

/**
 * Legacy getExtensionFromShopify: the extension of the URL's last path segment,
 * percent-decoded with spaces stripped.
 *
 * Infrastructure note: legacy only ever saw absolute URLs. Our uploads bucket
 * addresses artwork by S3 key ("TEST001/art.png"), which `new URL` rejects, so
 * a non-URL value falls back to plain path parsing rather than being reported
 * as a missing file. This widens what parses; it does not change any label,
 * dimension, or finishing decision.
 */
function extensionFromShopify(url) {
  const lastSegment = (s) => decodeURIComponent(String(s).split('/').pop()).replace(/\s+/g, '');
  let fileName;
  try {
    fileName = lastSegment(new URL(url).pathname);
  } catch {
    fileName = lastSegment(String(url ?? '').split('?')[0]);
  }
  return fileName && fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : null;
}

/** Legacy sanitizeFileLink (Shopify path only): percent-encode the artwork link. */
function sanitizeFileLink(fileLink) {
  if (!fileLink) return fileLink;
  try {
    return new URL(fileLink).href;
  } catch {
    return encodeURI(String(fileLink).trim());
  }
}

/**
 * Legacy getImageConfig: resolve the line's artwork and the flags that decide
 * whether the order can be processed at all. The two classes read different
 * fields, so this is where they diverge most.
 *
 * @returns {{ urls: string[], extension: string|null, isMissingFile: boolean,
 *             hasMultipleFiles: boolean }}
 */
function collectArtwork(vl, metadata, variant) {
  const none = { urls: [], extension: null, isMissingFile: false, hasMultipleFiles: false };

  if (variant === SHOPIFY) {
    // A single upload is "Uploaded File"; several become "Uploaded File 1"…N,
    // and then "Uploaded File" is absent. Legacy treats that as multi-file and
    // hands the order to sales rather than picking one.
    const fileLink = vl?.['Uploaded File'] || vl?.['UPLOADED FILE'];
    if (!fileLink) {
      if (vl?.['Uploaded File 1']) return { ...none, hasMultipleFiles: true };
      return { ...none, isMissingFile: true };
    }
    const extension = extensionFromShopify(fileLink);
    if (!extension || !VALID_FILE_EXTS.has(extension)) return { ...none, isMissingFile: true };
    return { urls: [sanitizeFileLink(fileLink)], extension, isMissingFile: false, hasMultipleFiles: false };
  }

  // QTS: artwork links live in metadata.image1 … image5.
  const links = metadata
    ? Object.entries(metadata)
        .filter(([k]) => k.includes('image') && /^[1-5]$/.test(k.slice(5)))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, v]) => v)
    : [];

  if (links.length === 0) return { ...none, isMissingFile: true };
  if (links.length > 1) return { ...none, hasMultipleFiles: true };

  const extension = extensionFromUrl(links[0]);
  if (!extension || !VALID_FILE_EXTS.has(extension)) return { ...none, isMissingFile: true };
  return { urls: [links[0]], extension, isMissingFile: false, hasMultipleFiles: false };
}

// --- per-order flags -------------------------------------------------------

/** Legacy checkSpecialProduct: products the bot never auto-processes. */
const isSpecialProduct = (name) => {
  const n = String(name ?? '').toLowerCase();
  return n.includes('pop up display') || n.includes('sticker');
};

/** Legacy checkSeeThru. */
const isSeeThru = (name) => {
  const n = String(name ?? '').toLowerCase();
  return n.includes('see thru') || n.includes('see through');
};

/**
 * Legacy checkInstructions. ShopifyDetails guards against a missing field;
 * QTSOrderDetails does not and throws. We use the guarded form for both.
 */
const hasInstructionsText = (v) => Boolean(v && String(v).length > 0);

/** Legacy checkDC: order numbers starting "000" are distribution-centre orders. */
const isDcOrder = (orderName) => String(orderName ?? '').startsWith('000');

/** Map an OrderDesk order JSON into our cleaned "job" shape. */
export function cleanOrder(order) {
  const variant = orderVariant(order);
  const shopify = variant === SHOPIFY;

  const items = (order.order_items ?? []).map((it) => {
    const vl = it.variation_list ?? {};
    const sku = it.code ?? vl.SKU;
    const quantity = Number(it.quantity ?? 1);

    // ShopifyDetails accepts the store's alternate field spellings; QTS reads
    // only the upper-case forms.
    const rawWidth = shopify ? (vl.WIDTH ?? vl.Width) : vl.WIDTH;
    const rawHeight = shopify ? (vl.HEIGHT ?? vl.Height) : vl.HEIGHT;
    const finish = shopify
      ? (vl['FINISHING OPTIONS'] ?? vl['Finishing Options'] ?? vl['Finishing options'] ?? 'not available')
      : vl['FINISHING OPTIONS'];
    const instructions = shopify
      ? (vl['SPECIAL INSTRUCTIONS'] ?? vl['Special Instructions'])
      : vl['SPECIAL INSTRUCTIONS'];

    // Resolve dimensions/unit (with legacy remap) BEFORE finishing, so grommet
    // counts use the effective size — exactly as the legacy order path did.
    const { width, height, unit } = resolveDimensions(sku, it.name, rawWidth, rawHeight, variant);

    const art = collectArtwork(vl, it.metadata, variant);

    const noFinish = isNoFinishSku(sku);
    const finishingObj = noFinish
      ? { quantity }
      : getFinishObj(finish, width, height, unit, quantity, { variant, productName: it.name });

    return {
      sku,
      name: it.name,
      quantity,
      width,
      height,
      unit,
      finishingRaw: finish,
      finishingObj,
      artworkUrl: art.urls[0],
      artworkUrls: art.urls,
      artworkExt: art.extension ?? undefined,
      // Legacy per-line flags. The order-level rollup below is what decides
      // whether the pipeline may touch this order at all.
      isMissingFile: art.isMissingFile,
      hasMultipleFiles: art.hasMultipleFiles,
      hasSpecialProduct: isSpecialProduct(it.name),
      hasSeeThru: isSeeThru(it.name),
      hasInstructions: hasInstructionsText(instructions),
      // Flag a product the system hasn't been set up for, so staff can review it.
      ...(isKnownSku(sku) ? {} : { unknownSku: true }),
    };
  });

  const shipping = {
    state: order.shipping?.state,
    postalCode: order.shipping?.postal_code,
    method: order.shipping_method,
    name: [order.shipping?.first_name, order.shipping?.last_name].filter(Boolean).join(' '),
  };

  const routing = routeOrder(shipping);
  const orderName = String(order.source_id ?? order.id ?? '');
  const any = (k) => items.some((it) => it[k]);

  return {
    orderName,
    variant,
    createdAt: toIso(order.date_added),
    folder: order.folder_name,
    financialStatus: order.payment_status,
    customer: { email: order.email, name: shipping.name },
    shipping,
    routing,
    needsProof: wantsProof(order),
    // Legacy's order-level rollup (QTSOrderDetails.init / ShopifyDetails.init).
    // Consumed by the intake gate — see src/shared/intake-gate.mjs.
    flags: {
      isMissingFile: any('isMissingFile'),
      hasMultipleFiles: any('hasMultipleFiles'),
      hasSpecialProduct: any('hasSpecialProduct'),
      hasSeeThru: any('hasSeeThru'),
      hasInstructions: any('hasInstructions'),
      isDc: isDcOrder(orderName),
    },
    // True if any line item is a product the system hasn't been set up for.
    ...(items.some((it) => it.unknownSku) ? { hasUnknownSku: true } : {}),
    totals: {
      subtotal: num(order.product_total),
      grandTotal: num(order.order_total),
      currency: order.currency ?? 'USD',
    },
    items,
    source: { orderDeskId: String(order.id ?? '') },
  };
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
