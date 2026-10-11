// Staff release of an order held for special instructions (Kai, 2026-10-11).
//
// The intake gate stops every order whose customer typed special instructions
// (Linh's hasInstructions -> Manual): nothing is resized, proofed or sent.
// These orders are made by hand, start to finish -- the office reads the
// instructions and makes the print file itself, as sales does today. The
// dashboard then lets a person either
//
//   final    attach the finished print file for every item. Nothing is
//            resized or marked: each file goes to the facility exactly as
//            attached. The pipeline only makes a preview of it for the
//            customer's proof page and the invoice thumbnail, sends the proof
//            email when the customer asked for one, waits for the approval,
//            then puts the files in the facility's FTP folder and moves the
//            order to the facility folder in OrderDesk.
//   as-is    the instructions do not change the print ("PO 7710", "blind
//            ship"): run the order like any other.
//
// Pure: no I/O, so it unit-tests. index.mjs does the reads and writes. Touches
// our own job record only, never OrderDesk.

import { VALID_FILE_EXTS } from '../../shared/orderdesk.mjs';

export const MODES = ['final', 'as-is'];

/** Holds a person can release from the dashboard. */
export const RELEASABLE = ['special-instructions'];

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

/** The file name staff gave it, without the upload timestamp. */
export function uploadedName(key) {
  return String(key).split('/').pop().replace(/^\d+-/, '');
}

/**
 * Work out the new row and the job to re-run, or why not.
 *
 * @param {object} meta  the order's META row
 * @param {{ mode: 'final'|'as-is', items?: Array<{ itemNo: number|string, uploadKey: string }> }} body
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
  const files = [];
  if (mode === 'final') {
    const given = new Map((body.items ?? []).map((e) => [String(e.itemNo), e.uploadKey]));
    const out = [];
    for (const [i, item] of items.entries()) {
      const no = item.itemNo ?? i + 1;
      const key = given.get(String(no));
      if (!key) return { code: 400, error: `attach the final file for item ${no} first` };
      if (!String(key).startsWith(`${uploadPrefix(meta.orderName)}${no}/`)) {
        return { code: 400, error: `item ${no}: that upload does not belong to this item` };
      }
      const ext = (String(key).match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
      if (!VALID_FILE_EXTS.has(ext)) return { code: 400, error: `item ${no}: file type .${ext} cannot be printed` };
      const url = `s3://${uploadsBucket}/${key}`;
      out.push({
        ...item,
        itemNo: no,
        customerArtworkUrl: item.customerArtworkUrl ?? item.artworkUrl,
        artworkUrl: url,
        artworkUrls: [url],
        artworkExt: ext,
        finalFileName: uploadedName(key),
        isMissingFile: false,
        hasMultipleFiles: false,
      });
      files.push({ itemNo: no, file: uploadedName(key) });
    }
    items = out;
  }

  const release = { mode, by, at: now, reason: meta.hold.reason, ...(files.length ? { items: files } : {}) };
  const job = {
    ...meta,
    items,
    // staffRelease lets the OrderDesk move take the order out of the staff
    // folder (Manual) it was held in -- a person chose to send it on.
    staffRelease: true,
    instructionsRelease: release,
    // The files are final: resize only previews them, finish sends them as is.
    ...(mode === 'final' ? { manualFiles: true } : {}),
  };
  for (const k of ROW_ONLY) delete job[k];
  return { items, job, release };
}
