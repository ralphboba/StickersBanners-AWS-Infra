// Staff release of an order held for special instructions (Kai, 2026-10-11).
//
// The intake gate stops every order whose customer typed special instructions
// (Linh's hasInstructions -> Manual): nothing is resized, proofed or sent. A
// person reads the instructions on the dashboard and then either
//
//   as-is    lets it run exactly as ordered ("PO 7710", "blind ship", ...), or
//   changes  fixes what the instructions ask for, per item: the size, the
//            finishing, where the grommets go, and/or a file the office edited
//            and uploaded in place of the customer's.
//
// Either way the order goes back on the intake queue and runs the normal
// pipeline from the top -- resize, finishing, proof (and the proof email when
// the customer asked for one), approval, transfer -- so an edited order comes
// out named, marked and filed exactly like any other.
//
// Pure: no I/O, so it unit-tests. index.mjs does the reads and writes. Touches
// our own job record only, never OrderDesk.

import { getFinishObj, getGrommetsCount2, VALID_FILE_EXTS } from '../../shared/orderdesk.mjs';
import { MAX_SIDE_INCHES } from '../../shared/intake-gate.mjs';

export const MODES = ['as-is', 'changes'];

/** Holds a person can release from the dashboard. */
export const RELEASABLE = ['special-instructions'];

/** The finishing options the store sells, as the store spells them. */
export const FINISH_CHOICES = [
  'Hem & Grommets',
  'Hem Only',
  'No Hem / Grommets Only',
  'No Hem & No Grommets',
  'Pole Pockets (Top Only)',
  'Pole Pockets (Bottom Only)',
  'Pole Pockets (Top and Bottom)',
];

/**
 * Where grommet marks go. The print file never marks the corners (Linh:
 * production does not need them), so "corners only" draws no marks at all.
 */
export const GROMMET_SIDES = {
  all: ['top', 'left', 'right', 'bottom'],
  top: ['top'],
  bottom: ['bottom'],
  'top-bottom': ['top', 'bottom'],
  'left-right': ['left', 'right'],
  corners: [],
};

/** Fields that belong to the row, not to the job the pipeline runs on. */
const ROW_ONLY = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'status', 'stage', 'hold', 'sizeDecision'];

/** Where a staff upload for this order lives in the uploads bucket. */
export function uploadPrefix(orderName) {
  return `staff/${String(orderName).replace(/[^A-Za-z0-9_-]/g, '')}/`;
}

/** A safe object key for a staff upload, or an error. */
export function uploadKey(orderName, itemNo, filename, now = Date.now()) {
  const base = String(filename ?? '').split(/[\\/]/).pop().trim();
  const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (!ext || !VALID_FILE_EXTS.has(ext)) {
    return { error: `file type .${ext || '?'} cannot be printed (use ${[...VALID_FILE_EXTS].join(', ')})` };
  }
  if (!/^\d+$/.test(String(itemNo ?? ''))) return { error: 'itemNo must be a number' };
  // No spaces or odd characters: the key travels through URLs, S3 and FTP.
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
  return { key: `${uploadPrefix(orderName)}${itemNo}/${now}-${safe}`, ext };
}

const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

/** Apply one item's edits; returns the new item or an error. */
function editItem(item, edit, ctx) {
  const next = { ...item };
  const changes = {};

  // Size
  const hasSize = edit.width !== undefined || edit.height !== undefined || edit.unit !== undefined;
  if (hasSize) {
    const width = num(edit.width ?? item.width);
    const height = num(edit.height ?? item.height);
    const unit = edit.unit ?? item.unit ?? 'ft';
    if (!(width > 0) || !(height > 0)) return { error: `item ${item.itemNo}: size must be two positive numbers` };
    if (!['ft', 'in'].includes(unit)) return { error: `item ${item.itemNo}: unit must be ft or in` };
    const scale = unit === 'ft' ? 12 : 1;
    if (width * scale > MAX_SIDE_INCHES || height * scale > MAX_SIDE_INCHES) {
      return { error: `item ${item.itemNo}: a side over ${MAX_SIDE_INCHES} in is handled by email, not here` };
    }
    if (width !== Number(item.width) || height !== Number(item.height) || unit !== item.unit) {
      changes.size = { from: `${item.width}x${item.height} ${item.unit}`, to: `${width}x${height} ${unit}` };
    }
    next.width = width;
    next.height = height;
    next.unit = unit;
  }

  // Finishing (recomputed whenever size or finishing changed: grommet counts
  // depend on the size)
  if (edit.finishing !== undefined && !FINISH_CHOICES.includes(edit.finishing)) {
    return { error: `item ${item.itemNo}: unknown finishing "${edit.finishing}"` };
  }
  if (edit.grommets !== undefined && !(edit.grommets in GROMMET_SIDES) && edit.grommets !== 'none') {
    return { error: `item ${item.itemNo}: unknown grommet position "${edit.grommets}"` };
  }
  const finishing = edit.finishing ?? item.finishingRaw;
  if (edit.finishing !== undefined && edit.finishing !== item.finishingRaw) {
    changes.finishing = { from: item.finishingRaw ?? '', to: edit.finishing };
  }
  if (hasSize || edit.finishing !== undefined || edit.grommets !== undefined) {
    next.finishingRaw = finishing;
    const obj = getFinishObj(finishing, next.width, next.height, next.unit, next.quantity ?? 1,
      { variant: 'shopify', productName: item.name });
    if (edit.grommets === 'none') {
      delete obj.grommets;
    } else if (edit.grommets !== undefined) {
      const [widthGrommets, heightGrommets] = getGrommetsCount2(
        parseInt(next.width, 10), parseInt(next.height, 10), next.unit);
      obj.grommets = { ...(obj.grommets ?? { widthGrommets, heightGrommets }), sides: GROMMET_SIDES[edit.grommets] };
    }
    if (edit.grommets !== undefined) changes.grommets = edit.grommets;
    next.finishingObj = obj;
  }

  // Edited file
  if (edit.uploadKey !== undefined) {
    if (!String(edit.uploadKey).startsWith(`${uploadPrefix(ctx.orderName)}${item.itemNo}/`)) {
      return { error: `item ${item.itemNo}: that upload does not belong to this item` };
    }
    const ext = (String(edit.uploadKey).match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (!VALID_FILE_EXTS.has(ext)) return { error: `item ${item.itemNo}: file type .${ext} cannot be printed` };
    next.customerArtworkUrl = item.customerArtworkUrl ?? item.artworkUrl;
    next.artworkUrl = `s3://${ctx.uploadsBucket}/${edit.uploadKey}`;
    next.artworkUrls = [next.artworkUrl];
    next.artworkExt = ext;
    next.isMissingFile = false;
    next.hasMultipleFiles = false;
    changes.file = String(edit.uploadKey).split('/').pop().replace(/^\d+-/, '');
  }

  // A person looked at this item and decided; resize must not stop it again
  // to ask whether the file is the other way round.
  if (Object.keys(changes).length) next.orientationChecked = true;
  return { item: next, changes };
}

/**
 * Work out the new row and the job to re-run, or why not.
 *
 * @param {object} meta  the order's META row
 * @param {{ mode: 'as-is'|'changes', items?: Array<{ itemNo: number|string,
 *           width?: number, height?: number, unit?: 'ft'|'in', finishing?: string,
 *           grommets?: string, uploadKey?: string }> }} body
 * @returns {{ error: string, code: number } | { items: object[], job: object, release: object }}
 */
export function applyRelease(meta, body, { by = 'staff', now = new Date().toISOString(), uploadsBucket = '' } = {}) {
  if (!meta) return { code: 404, error: 'not found' };
  if (meta.mirror) return { code: 403, error: "this order is Linh's program's, not ours" };
  if (meta.status !== 'needs_review' || !RELEASABLE.includes(meta.hold?.reason)) {
    return { code: 409, error: 'this order is not waiting on special instructions' };
  }
  const mode = body?.mode;
  if (!MODES.includes(mode)) return { code: 400, error: `mode must be one of ${MODES.join(', ')}` };

  let items = meta.items ?? [];
  const changed = [];
  if (mode === 'changes') {
    const edits = new Map((body.items ?? []).map((e) => [String(e.itemNo), e]));
    if (!edits.size) return { code: 400, error: 'no changes given' };
    for (const no of edits.keys()) {
      if (!items.some((it, i) => String(it.itemNo ?? i + 1) === no)) return { code: 400, error: `no item ${no}` };
    }
    const out = [];
    for (const [i, item] of items.entries()) {
      const edit = edits.get(String(item.itemNo ?? i + 1));
      if (!edit) { out.push(item); continue; }
      const r = editItem({ ...item, itemNo: item.itemNo ?? i + 1 }, edit,
        { orderName: meta.orderName, uploadsBucket });
      if (r.error) return { code: 400, error: r.error };
      out.push(r.item);
      if (Object.keys(r.changes).length) changed.push({ itemNo: r.item.itemNo, ...r.changes });
    }
    if (!changed.length) return { code: 400, error: 'nothing was changed -- use "Process as is"' };
    items = out;
  }

  const release = { mode, by, at: now, reason: meta.hold.reason, ...(changed.length ? { items: changed } : {}) };
  // staffRelease lets the OrderDesk move take the order out of the staff
  // folder (Manual) it was held in -- a person chose to send it on.
  const job = { ...meta, items, staffRelease: true, instructionsRelease: release };
  for (const k of ROW_ONLY) delete job[k];
  return { items, job, release };
}
