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
  isInchSku, isNoFinishSku, isKnownSku, isHardwareSku, fixedDimensions,
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
  // Not a legacy key. The live store also sells "Grommet with Bravo Tab (TOP
  // only)", which legacy matches nowhere. Linh: bravo tabs are "treated the same
  // as regular grommets" — the position is set by a sales rep afterwards, and a
  // customer can only request one via SPECIAL INSTRUCTIONS (which sends the
  // order to a person anyway). So all four sides, same as the plain key.
  'grommetwithbravotabtoponly',
]);

const fourSides = () => ({ grommets: { sides: ['top', 'left', 'right', 'bottom'] } });

/**
 * The size of a line item, as the store actually recorded it.
 *
 * Legacy reads WIDTH/HEIGHT and nothing else, which was right for the products
 * that existed when it was written. The store has since added product types
 * that put the size somewhere else entirely, and a key we do not read is not an
 * error — it is a line item with `width: undefined` that sails through the
 * intake gate and dies in resize on `float(None)`. Found by auditing a single
 * day (2026-09-22): 11 line items across 9 orders, 4 of which would have
 * reached print.
 *
 * The four shapes, all seen in live orders that day:
 *
 *   WIDTH / HEIGHT                "4" / "6"                    legacy, unit inferred
 *   Width (Feet) / Height (Feet)  "5" / "3"                    unit stated
 *   Width (Inches) / Height …     "4" / "4"                    unit stated
 *   Size (WxH) Inches             `145" x 91" (10' x 8' Feet)` unit stated
 *   Diameter (Inches)             `4" Round`                   unit stated, one number
 *
 * Where the key names the unit, that unit is RETURNED AS A HINT and beats the
 * SKU-table guess downstream, because a stated unit is data and the table is
 * inference. Where it does not — the legacy pair — nothing is hinted and the
 * existing rules run exactly as before, so no order that parses today changes.
 *
 * @returns {{ rawWidth: *, rawHeight: *, unitHint?: 'in'|'ft' }}
 */
export function readDimensions(variationList, { shopify = true } = {}) {
  const vl = variationList ?? {};

  // Legacy first, so its behaviour is never displaced by a newer key.
  const legacyWidth = shopify ? (vl.WIDTH ?? vl.Width) : vl.WIDTH;
  const legacyHeight = shopify ? (vl.HEIGHT ?? vl.Height) : vl.HEIGHT;
  if (legacyWidth !== undefined || legacyHeight !== undefined) {
    return { rawWidth: legacyWidth, rawHeight: legacyHeight };
  }

  // The store is inconsistent about case and spacing ("UPLOADED FILE" next to
  // "Uploaded File" in the same day's orders), so match on a normalised key.
  const byKey = new Map();
  for (const [key, value] of Object.entries(vl)) {
    byKey.set(String(key).toLowerCase().replace(/\s+/g, ' ').trim(), value);
  }

  /** Leading number of a value like `145" x 91" (10' x 8' Feet)` or `4" Round`. */
  const firstNumbers = (value, count) => {
    // Anything in parentheses is a restatement in the OTHER unit — the whole
    // point of these keys is that the unit is in the key name, so a value that
    // also says `(10' x 8' Feet)` must not contribute its numbers.
    const head = String(value ?? '').split('(')[0];
    const found = head.match(/-?\d+(?:\.\d+)?/g) ?? [];
    return found.slice(0, count).map(Number);
  };

  for (const [suffix, unit] of [['feet', 'ft'], ['ft', 'ft'], ['inches', 'in'], ['in', 'in']]) {
    const width = byKey.get(`width (${suffix})`);
    const height = byKey.get(`height (${suffix})`);
    if (width !== undefined || height !== undefined) {
      return { rawWidth: width, rawHeight: height, unitHint: unit };
    }

    // One field holding both, e.g. `Size (WxH) Inches`.
    const combined = byKey.get(`size (wxh) ${suffix}`);
    if (combined !== undefined) {
      const [w, h] = firstNumbers(combined, 2);
      if (Number.isFinite(w) && Number.isFinite(h)) {
        return { rawWidth: w, rawHeight: h, unitHint: unit };
      }
    }

    // Round products state a diameter. The print is still a square of that
    // side, so both dimensions take it rather than inventing a shape concept.
    const diameter = byKey.get(`diameter (${suffix})`);
    if (diameter !== undefined) {
      const [d] = firstNumbers(diameter, 1);
      if (Number.isFinite(d)) return { rawWidth: d, rawHeight: d, unitHint: unit };
    }
  }

  return { rawWidth: undefined, rawHeight: undefined };
}

/**
 * Legacy getUnit: pick the unit and remap certain nominal sizes to inches.
 * Mutates nothing — returns the effective { width, height, unit }.
 */
export function resolveDimensions(sku, productName, rawWidth, rawHeight, variant = SHOPIFY,
                                  unitHint = undefined) {
  // Fixed-size products (e.g. tents) print at a set size regardless of the
  // order's WIDTH/HEIGHT. Return those dimensions verbatim (bleed = print size).
  // Not a legacy rule — these products postdate the legacy program.
  const fixed = fixedDimensions(sku);
  if (fixed) return { ...fixed };

  // The variation key named the unit (readDimensions). Then every rule below is
  // the wrong tool: isInchSku is a guess at the unit, and the 8x8 / 4x4 remaps
  // exist to catch a nominal size quoted in feet that is really inches. Applied
  // to a value the store already labelled `Width (Inches)`, they would turn a
  // genuine 8x8 inch sticker into 92x92. Stated data wins.
  if (unitHint) {
    return { width: parseFloat(rawWidth), height: parseFloat(rawHeight), unit: unitHint };
  }

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
    // Same treatment as regular grommets — Linh confirmed. See
    // GROMMETS_FINISHES_SHOPIFY for why the position is not decided here.
    case 'grommetwithbravotabtoponly':
      return shopify ? fourSides() : {};
    case 'nohem/grommetsonly':
    case 'nohem/grommetsonlyy':
    case 'grommetsonly':
      return { grommets: { sides: ['top', 'left', 'right', 'bottom'] }, isOnly: true, descSuf: 'GO' };
    case 'nohemnogrommets':
      return { descSuf: 'CO' };
    // Not a legacy key (neither class matches it). Live-store spelling of "no
    // hem, no grommets"; without it a "Cut Only" order gets no CO suffix.
    // Linh confirmed adding it is correct.
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

  // Legacy numbers the lines BEFORE dropping hardware (`index+1`, then
  // `items.filter(Boolean)`), so removing a stand does not renumber the banner
  // after it. itemNo is carried through to the workers for exactly that reason.
  const items = (order.order_items ?? []).map((it, index) => {
    const vl = it.variation_list ?? {};
    const sku = it.code ?? vl.SKU;
    const quantity = Number(it.quantity ?? 1);
    const itemNo = index + 1;

    // ShopifyDetails accepts the store's alternate field spellings; QTS reads
    // only the upper-case forms. readDimensions also covers the newer product
    // types that record the size under a key naming its own unit.
    const { rawWidth, rawHeight, unitHint } = readDimensions(vl, { shopify });
    const finish = shopify
      ? (vl['FINISHING OPTIONS'] ?? vl['Finishing Options'] ?? vl['Finishing options'] ?? 'not available')
      : vl['FINISHING OPTIONS'];
    const instructions = shopify
      ? (vl['SPECIAL INSTRUCTIONS'] ?? vl['Special Instructions'])
      : vl['SPECIAL INSTRUCTIONS'];

    // Resolve dimensions/unit (with legacy remap) BEFORE finishing, so grommet
    // counts use the effective size — exactly as the legacy order path did.
    const { width, height, unit } = resolveDimensions(sku, it.name, rawWidth, rawHeight, variant, unitHint);

    const art = collectArtwork(vl, it.metadata, variant);

    const noFinish = isNoFinishSku(sku);
    const finishingObj = noFinish
      ? { quantity }
      : getFinishObj(finish, width, height, unit, quantity, { variant, productName: it.name });

    return {
      itemNo,
      // OrderDesk line-item id. The transfer step renames each proof JPG to
      // this before uploading to /proof, because the OrderDesk invoice looks
      // the thumbnail up by it (Linh: "invoices will show them for production
      // to use as reference").
      proofName: it.id === undefined || it.id === null ? undefined : String(it.id),
      sku,
      name: it.name,
      quantity,
      width,
      height,
      // What OrderDesk recorded, kept alongside the resolved values so a wrong
      // size can be traced to our parse or to the source data. Carried through
      // to the poller's dryRun report; nothing downstream reads them.
      rawWidth,
      rawHeight,
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
      // Physical goods with no artwork — dropped from the order below.
      hardware: isHardwareSku(sku, it.name),
      // Flag a product the system hasn't been set up for, so staff can review it.
      ...(isKnownSku(sku) ? {} : { unknownSku: true }),
    };
  });

  // Legacy checkHardwareSku + items.filter(Boolean): stands, carpets and poles
  // leave the order entirely, so an order that mixes a banner with a separately
  // ordered stand still processes the banner instead of stalling on the stand's
  // missing artwork.
  const hardwareItems = items.filter((it) => it.hardware);
  const printItems = items.filter((it) => !it.hardware);

  const shipping = {
    state: order.shipping?.state,
    postalCode: order.shipping?.postal_code,
    method: order.shipping_method,
    name: [order.shipping?.first_name, order.shipping?.last_name].filter(Boolean).join(' '),
  };

  // See-thru decals are forced to NV and blocked from CA pickup (legacy
  // determineProduction / getState), so routing needs the flag and the method.
  const routing = routeOrder(shipping, {
    seeThru: printItems.some((it) => it.hasSeeThru),
  });
  const orderName = String(order.source_id ?? order.id ?? '');
  const any = (k) => printItems.some((it) => it[k]);

  // Legacy getProofName: proof JPG name -> OrderDesk line-item id, consumed by
  // the transfer step's rename before the /proof upload.
  const renameDict = Object.fromEntries(
    printItems
      .filter((it) => it.proofName)
      .map((it) => [`${it.itemNo}-1`, it.proofName]),
  );

  return {
    orderName,
    variant,
    createdAt: toIso(order.date_added),
    folder: order.folder_name,
    financialStatus: order.payment_status,
    customer: { email: order.email, name: shipping.name },
    shipping,
    routing,
    needsProof: wantsProof(order, variant),
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
    renameDict,
    // Hardware lines removed from processing, kept for the record/dashboard.
    ...(hardwareItems.length ? { hardwareItems: hardwareItems.map((it) => ({ itemNo: it.itemNo, sku: it.sku, name: it.name })) } : {}),
    // True if any line item is a product the system hasn't been set up for.
    ...(printItems.some((it) => it.unknownSku) ? { hasUnknownSku: true } : {}),
    totals: {
      subtotal: num(order.product_total),
      grandTotal: num(order.order_total),
      currency: order.currency ?? 'USD',
    },
    items: printItems,
    source: { orderDeskId: String(order.id ?? '') },
  };
}

/**
 * Legacy getProofOption (OrderDetails.mjs — shared by both order classes).
 *
 * Reads ONE field of `checkout_data`, and the rule is opt-OUT: an order gets a
 * proof unless that field is empty or says "no proof".
 *
 *   Shopify / source_id starting "S"  ->  checkout_data.Note
 *   everything else                   ->  checkout_data['Proof Option']
 *
 * This replaces an earlier guess that searched customer_note, internal_note,
 * SPECIAL INSTRUCTIONS, PROOF and "Proof Options" for the substring "proof".
 * That was both the wrong field and the wrong direction: a field reading
 * "Yes" produced false, so most orders skipped Proofing entirely and no
 * Zendesk proof email was sent.
 */
function wantsProof(order, variant) {
  const key = variant === SHOPIFY ? 'Note' : 'Proof Option';
  const value = order?.checkout_data?.[key];
  if (!value) return false;
  return !String(value).toLowerCase().includes('no proof');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toIso(v) {
  const d = v ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
