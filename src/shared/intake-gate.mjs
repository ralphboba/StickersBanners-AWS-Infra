// Intake gate — ported from the legacy SBBotExpress batch loop
// (src/utils/queueManager/queueHelpers.mjs, getBatchJobData).
//
// Legacy does NOT auto-process every order in the QTS folder. Before an order
// reaches the workers it runs five checks, and any one of them takes the order
// out of the automatic flow: the bot re-tags it and moves it to a staff folder
// in OrderDesk, then skips it. Only orders that clear all five are processed.
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
 * The five checks, in legacy order. `flag` is the key on job.flags computed by
 * cleanOrder; `reason` is ours, for the dashboard and the logs.
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
];

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
    if (flags[gate.flag]) {
      return {
        reason: gate.reason,
        tag: gate.tag,
        folder: gate.folder,
        folderId: ORDERDESK_FOLDERS[gate.folder],
        tagValue: ORDERDESK_TAGS[gate.tag],
        explain: gate.explain,
      };
    }
  }
  return null;
}
