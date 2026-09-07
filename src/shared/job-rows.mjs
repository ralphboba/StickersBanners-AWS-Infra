// Rules for the two kinds of row that share one key in the jobs table.
//
// Both the display-only mirror and the real intake poller write
// PK=ORDER#<name>, SK=META. They mean different things:
//
//   mirror row   (mirror: true) — a real OrderDesk order copied onto the
//                dashboard so staff can SEE the live board. Nothing was
//                queued, nothing was processed. Rewritten every mirror sync,
//                and deleted once the order leaves every mirrored folder.
//
//   order row    (no mirror flag) — an order this pipeline actually took in.
//                Owned by the poller and the state machine from then on.
//
// Because they collide on the key, the mirror row must never look like work
// already done, and must never be overwritten or deleted as if it were a
// mirror row once the pipeline has claimed it. Everything that decides that
// lives here so the three call sites cannot drift apart.

/** A display-only row the mirror wrote. */
export function isMirrorRow(item) {
  return item?.mirror === true;
}

/**
 * Has this order already been taken into the pipeline?
 *
 * A mirror row means NO — the mirror sees every order in the intake folder, so
 * treating its rows as "seen" would make the poller skip every real order the
 * moment it is enabled.
 */
export function isClaimed(item) {
  return Boolean(item) && !isMirrorRow(item);
}

/**
 * Condition for the poller's writes: create the row, or take over a mirror row.
 * Fails when a real order row already exists, which is the dedupe guard
 * (and the race guard against a concurrent poll).
 *
 * Pair with MIRROR_VALUES for the expression values.
 */
export const CLAIM_CONDITION = 'attribute_not_exists(PK) OR mirror = :mirrorTrue';

/**
 * Condition for the mirror's own writes and deletes: only ever touch a row the
 * mirror owns. Without this on the delete, pruning an order that left the
 * mirrored folders would wipe a real processed order.
 */
export const MIRROR_ONLY_CONDITION = 'mirror = :mirrorTrue';

/** Expression values for both conditions above. */
export const MIRROR_VALUES = { ':mirrorTrue': true };

/** DynamoDB's "your ConditionExpression said no" error. */
export function isConditionFailure(err) {
  return err?.name === 'ConditionalCheckFailedException';
}
