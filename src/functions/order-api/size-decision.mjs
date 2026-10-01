// Staff answer for an order resize held as "size-swapped".
//
// Resize stops an order whose file is the other way round from what was ordered
// (src/services/resize/orientation.py) -- a customer who uploads 8x3 but picks
// 3x8. Somebody has to say which one is right, and this applies the answer:
//
//   swap  print it the way the FILE is: width and height trade places, and so
//         do the grommet counts along them. Same area, so same price/material.
//   keep  print it as ordered; the artwork will be stretched, as it always was.
//
// Either way the item is marked orientationChecked so resize does not ask
// again, and the order goes back on the intake queue from the top. This touches
// our own job record only -- never OrderDesk.

export const CHOICES = ['swap', 'keep'];

/** Fields that belong to the row, not to the job the pipeline runs on. */
const ROW_ONLY = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'status', 'stage', 'hold', 'sizeDecision'];

function swapItem(item) {
  const out = { ...item, width: item.height, height: item.width };
  if ('widthFt' in item || 'heightFt' in item) {
    out.widthFt = item.heightFt;
    out.heightFt = item.widthFt;
  }
  const g = item.finishingObj?.grommets;
  if (g && typeof g === 'object') {
    out.finishingObj = {
      ...item.finishingObj,
      grommets: { ...g, widthGrommets: g.heightGrommets, heightGrommets: g.widthGrommets },
    };
  }
  return out;
}

/**
 * Work out the new row and the job to re-run, or why not.
 *
 * @returns {{ error: string, code: number }
 *         | { items: object[], decision: object, job: object }}
 */
export function applySizeDecision(meta, choice, { by = 'staff', now = new Date().toISOString() } = {}) {
  if (!meta) return { code: 404, error: 'not found' };
  if (!CHOICES.includes(choice)) return { code: 400, error: `choice must be one of ${CHOICES.join(', ')}` };
  if (meta.mirror) return { code: 403, error: "this order is Linh's program's, not ours" };
  if (meta.status !== 'needs_review' || meta.hold?.reason !== 'size-swapped') {
    return { code: 409, error: 'this order is not waiting on a size decision' };
  }

  const flagged = (meta.hold.items ?? []).map((f) => String(f.itemNo));
  if (!flagged.length) return { code: 409, error: 'the hold names no items' };
  // Pockets and stand bases are laid out per side; turning the banner changes
  // where they go, which only the customer can say.
  if (choice === 'swap' && (meta.hold.items ?? []).some((f) => f.hasPockets)) {
    return { code: 409, error: 'has pole pockets -- confirm the layout with the customer first' };
  }

  const items = (meta.items ?? []).map((item, i) => {
    if (!flagged.includes(String(item.itemNo ?? i + 1))) return item;
    const next = choice === 'swap' ? swapItem(item) : { ...item };
    next.orientationChecked = true;
    return next;
  });

  const job = { ...meta, items };
  for (const k of ROW_ONLY) delete job[k];

  return { items, job, decision: { choice, by, at: now, items: flagged } };
}
