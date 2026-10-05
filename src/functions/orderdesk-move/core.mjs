// Where an order goes in OrderDesk as the pipeline moves it on — and from where.
//
// Linh, 2026-10-05, on what his program does after intake:
//
//   proof sent        "The orders remain in proofing when the process is
//                      going on."                         Processing -> Proofing
//   customer approves "It sent to Pending review and then the python bot
//                      generate the final PR and then send those to
//                      productions accordingly."      Proofing -> Pending Review
//   files delivered   ... -> the facility folder (GA/NJ/TX/NV/CA)
//   no proof wanted   "it goes straight to production."
//                                                   Processing -> facility
//
// The intake move (QTS -> Processing, or to Manual/Sales for a person) is the
// poller's; this covers everything after it. Pure: no I/O, so it unit-tests.
//
// Each step names the folders the order must be in BEFORE it moves. If staff
// have moved it somewhere else in the meantime — to Manual, back to QTS,
// cancelled — that is a person's decision and we leave it alone: the move is
// skipped and recorded, never forced.

import { folderIds } from '../../shared/intake-gate.mjs';

export const STEPS = ['proofing', 'review', 'facility'];
const FACILITIES = ['GA', 'NJ', 'TX', 'NV', 'CA'];

/**
 * @param {object} job   the pipeline's state (the order's job)
 * @param {'proofing'|'review'|'facility'} step
 * @param {Record<string,string>} [ids]  folder key -> id (trial overrides applied)
 * @returns {{ folder: string, folderId: string, expectFrom: string[] }
 *         | { skip: string }}
 */
export function planMove(job, step, ids = folderIds()) {
  if (!STEPS.includes(step)) return { skip: `unknown step ${step}` };
  if (!job?.source?.orderDeskId) return { skip: 'no OrderDesk id on the job' };

  if (step === 'proofing') {
    return { folder: 'proofing', folderId: ids.proofing, expectFrom: [ids.processing] };
  }
  if (step === 'review') {
    return { folder: 'review', folderId: ids.review, expectFrom: [ids.proofing] };
  }
  const facility = job?.routing?.facility;
  if (!FACILITIES.includes(facility)) return { skip: `no facility (${facility ?? 'unrouted'})` };
  return {
    folder: facility,
    folderId: ids[facility],
    // After approval it waits in Pending Review; a no-proof order never left
    // Processing.
    expectFrom: job.needsProof ? [ids.review] : [ids.processing],
  };
}

/**
 * Is the order where the plan expects it? An order already at the destination
 * counts as done (a retried step must not report an error).
 *
 * @param {string|number} currentFolderId
 * @param {{ folderId: string, expectFrom: string[] }} plan
 * @returns {'move'|'already-there'|'moved-by-someone-else'}
 */
export function checkFrom(currentFolderId, plan) {
  const now = String(currentFolderId ?? '');
  if (now === String(plan.folderId)) return 'already-there';
  return plan.expectFrom.map(String).includes(now) ? 'move' : 'moved-by-someone-else';
}
