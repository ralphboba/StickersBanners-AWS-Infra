// Intake gate — ported from the legacy SBBotExpress batch loop
// (src/utils/queueManager/queueHelpers.mjs, getBatchJobData).
//
// Legacy does NOT auto-process every order in the QTS folder. Before an order
// reaches the workers it runs five checks, and any one of them takes the order
// out of the automatic flow: the bot re-tags it and moves it to a staff folder
// in OrderDesk, then skips it. Only orders that clear all five are processed.
//
// Two more checks are ours, both added when the production transfer was about
// to be armed for real: an item whose size is implausibly large
// (MAX_SIDE_INCHES), and an order with no printable item at all. They run AFTER
// Linh's five so they can never change which of his reasons an order reports,
// and like his they only divert the order to a person.
//
// The legacy order is significant and preserved here — an order that trips more
// than one check is reported under the first one legacy would have hit:
//
//     hasSpecialProduct  -> Blue    -> sales    (return before job data)
//     hasMultipleFiles   -> Yellow  -> sales    (return before job data)
//     ---- legacy writes resize/finish job data to Redis at this point ----
//     hasInstructions    -> Purple  -> manual
//     isDc               -> Orange  -> manual
//     isMissingFile      -> Red     -> manual
//
// This module only decides. Acting on the decision (the OrderDesk folder move)
// lives in orderdesk-write.mjs and is disabled by default — see that file.

/** Legacy folderLib (src/utils/helpers/updateOrder.mjs). */
export const ORDERDESK_FOLDERS = {
  processing: '650227',
  proofing: '651474',
  manual: '652268',
  review: '653109',
  sales: '657836',
  GA: '73068',
  NJ: '73069',
  TX: '73070',
  NV: '674352',
  CA: '42928',
};

/**
 * Temporary redirection of the folders above, as JSON in ORDERDESK_FOLDER_IDS.
 *
 * A trial run has to park orders somewhere other than the live staff folders —
 * Linh's condition for switching his scanner off was that he could still tell
 * which orders had been touched. The redirection is a deployed setting rather
 * than an edit to the table above, because that table is the record of his real
 * folder ids and has to survive the trial intact: ending the trial is removing
 * the variable, not remembering five numbers correctly under time pressure.
 *
 * Unparsable JSON is ignored with a loud log rather than throwing — a typo here
 * must not take the poller down, and the fallback (the real folders) is the
 * behaviour we already have.
 *
 * @returns {Record<string,string>} folder key -> id, overrides applied
 */
export function folderIds(env = process.env) {
  const raw = String(env.ORDERDESK_FOLDER_IDS ?? '').trim();
  if (!raw) return { ...ORDERDESK_FOLDERS };
  try {
    const parsed = JSON.parse(raw);
    const overrides = {};
    for (const [key, id] of Object.entries(parsed)) {
      if (!(key in ORDERDESK_FOLDERS)) {
        console.warn(JSON.stringify({ msg: 'unknown folder key in ORDERDESK_FOLDER_IDS', key }));
        continue;
      }
      if (!/^\d+$/.test(String(id))) {
        console.warn(JSON.stringify({ msg: 'folder id is not numeric, ignored', key, id }));
        continue;
      }
      overrides[key] = String(id);
    }
    return { ...ORDERDESK_FOLDERS, ...overrides };
  } catch (err) {
    console.error(JSON.stringify({
      msg: 'ORDERDESK_FOLDER_IDS is not valid JSON — using the real folders', error: String(err),
    }));
    return { ...ORDERDESK_FOLDERS };
  }
}

/** Legacy tagLib (same file): colour name -> OrderDesk tag value. */
export const ORDERDESK_TAGS = {
  Green: 'success',
  Red: 'error',
  Blue: 'info',
  Yellow: 'warning',
  Orange: 'orange',
  Purple: 'purple',
  White: 'x',
};

/**
 * The checks, in legacy order: Linh's five first, then ours. `flag` is the key
 * on job.flags computed by cleanOrder; `test` is a predicate for the checks
 * that read the job rather than a precomputed flag; `reason` is ours, for the
 * dashboard and the logs.
 */
export const GATES = [
  {
    flag: 'hasSpecialProduct',
    reason: 'special-product',
    tag: 'Blue',
    folder: 'sales',
    // legacy checkSpecialProduct: product name contains "pop up display" or "sticker"
    explain: 'Product is handled by sales, not the bot (pop up display / sticker)',
  },
  {
    flag: 'hasMultipleFiles',
    reason: 'multiple-files',
    tag: 'Yellow',
    folder: 'sales',
    explain: 'Line item has more than one uploaded file',
  },
  {
    flag: 'hasInstructions',
    reason: 'special-instructions',
    tag: 'Purple',
    folder: 'manual',
    explain: 'Customer left special instructions — needs a person to read them',
  },
  {
    flag: 'isDc',
    reason: 'dc-order',
    tag: 'Orange',
    folder: 'manual',
    explain: 'Distribution-centre order (order number starts 000)',
  },
  {
    flag: 'isMissingFile',
    reason: 'missing-file',
    tag: 'Red',
    folder: 'manual',
    explain: 'Artwork missing, or its file type is not one the workers accept',
  },
  // OURS, not legacy's — and deliberately LAST, so an order that also trips one
  // of Linh's five still reports his reason and lands where his bot would send
  // it. This only ever HOLDS an order for a human; it never alters a print.
  // See MAX_SIDE_INCHES below for why the threshold is where it is.
  {
    test: (job) => Boolean(oversizedItem(job)),
    reason: 'oversize',
    tag: 'Red',
    folder: 'manual',
    explain: 'An item is implausibly large — almost always inches read as feet',
  },
  // Also ours, and also last: an order can clear every check above and still
  // have nothing to print. Legacy drops hardware line items before the workers
  // ever see them (checkHardwareSku -> null, QTSOrderDetails.mjs:23) and so do
  // we, so an order for a stand and nothing else arrives here with items: [].
  //
  // Nothing downstream copes with that. Resize produces [], finish produces [],
  // and the transfer step dies on "No finished files found" after four
  // attempts — that is S61855 on 2026-09-19, an 8'x8' telescopic stand with no
  // banner. Legacy has the identical blind spot; the only difference is that
  // its empty job ends quietly instead of failing loudly.
  //
  // Somebody has to ship the hardware either way, so the order belongs in front
  // of that person rather than in the failure pile. Measured at 1 order in 559
  // (0.18%), so this cannot become noise staff learn to ignore.
  {
    test: (job) => (job?.items ?? []).length === 0,
    reason: 'nothing-to-print',
    tag: 'Red',
    folder: 'manual',
    explain: 'No printable item — hardware-only order, nothing for the workers to make',
  },
];

/**
 * Largest side, in inches, an item may have before a human has to look at it.
 *
 * NOT a legacy number — legacy has no size check at all, and neither did we
 * until the transfer was about to be armed for real. Every dimension bug found
 * so far has the same shape: a value quoted in inches is read as feet, so the
 * size comes out twelve times too big. Measured across 397 real line items, the
 * largest legitimate side was 228 in (a 19ft banner) and the next values up were
 * 1380 in — SKU-603 and SKU-607 recorded as "115x91 ft", which are 115x91
 * INCHES. The two populations are six times apart, so one threshold separates
 * them with room to spare: p90 of real items is 96 in, p99 is 216 in.
 *
 * 600 in is Linh's number, given on 2026-09-18: "there's technically no maximum
 * print size, but the biggest we delegated for the bot to proof is 50ft. The
 * bigger ones are handled via email manually." 50 ft is 600 in, and this gate
 * does exactly what he describes -- it hands the order to a person rather than
 * rejecting it.
 *
 * It was 300 before, chosen from the data alone, which would have held real
 * orders between 25 and 50 feet. The measured populations are still far apart
 * either way: the largest legitimate side seen was 228 in and the bad values
 * were 1380 in.
 *
 * It still catches the two parse cases that are unresolved: SKUAB arriving as
 * '48 in' x '80 in' (read as feet: 576 x 960) and SKUVB 144x18 (1728 x 216).
 * Note SKUAB is now caught by its HEIGHT alone -- 576 in sits under the line,
 * so a squarer order of the same shape would slip through. That one depends on
 * the SKU table being right, not on this gate.
 */
export const MAX_SIDE_INCHES = 600;

/** The first item whose finished size is implausible, or null. */
export function oversizedItem(job) {
  for (const item of job?.items ?? []) {
    const scale = item?.unit === 'ft' ? 12 : 1;
    const width = Number(item?.width) * scale;
    const height = Number(item?.height) * scale;
    // NaN compares false, so an unparsable size falls through to the workers
    // exactly as it does today — this check is about magnitude, nothing else.
    if (width > MAX_SIDE_INCHES || height > MAX_SIDE_INCHES) {
      return { item, widthIn: width, heightIn: height };
    }
  }
  return null;
}

/**
 * Decide whether an order may be auto-processed.
 *
 * @param {{ flags?: Record<string, boolean> }} job a cleaned job from cleanOrder
 * @returns {null | { reason: string, tag: string, folder: string,
 *                    folderId: string, tagValue: string, explain: string }}
 *          null when the order clears every gate (legacy: it gets queued).
 */
export function intakeGate(job) {
  const flags = job?.flags ?? {};
  for (const gate of GATES) {
    if (gate.test ? gate.test(job) : flags[gate.flag]) {
      return {
        reason: gate.reason,
        tag: gate.tag,
        folder: gate.folder,
        folderId: folderIds()[gate.folder],
        tagValue: ORDERDESK_TAGS[gate.tag],
        explain: gate.explain,
      };
    }
  }
  return null;
}
