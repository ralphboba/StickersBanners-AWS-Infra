// Daily count of customer shipping upgrades.
//
// Kai (2026-10-04): "몇 개의 오더들이 shipping upgrade를 하는지 … 매일 몇 개인지".
// Every request (order edit committed, balance left) and every payment (Order
// Desk written) leaves one row, grouped by the America/New_York day — the
// business's clock, the same one the legacy notes use:
//
//   PK UPGRADELOG#2026-10-03   SK 2026-10-03T14:02:11.000Z#paid#S64262#CHG-…
//
// The pending change record (SK CHANGE) cannot answer this: there is one per
// order and the test scripts delete it. These rows are never updated.
// Test orders (the page row's testOrder flag) are logged but not counted.

import { centsToAmount } from './money.mjs';

/** 'YYYY-MM-DD' of `ms` in America/New_York. */
export function nyDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

/** The New York day before the one `ms` falls in. */
export function nyYesterday(ms) {
  const [y, m, d] = nyDate(ms).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * @param {'requested'|'paid'} kind
 * @param {{ orderName: string, ref: string, from: string, to: string, shippingCents: number, taxCents?: number, test?: boolean }} change
 */
export function logItem(kind, change, atMs) {
  const at = new Date(atMs).toISOString();
  return {
    PK: `UPGRADELOG#${nyDate(atMs)}`,
    SK: `${at}#${kind}#${change.orderName}#${change.ref}`,
    kind, at, orderName: change.orderName, ref: change.ref, from: change.from, to: change.to,
    shippingCents: change.shippingCents ?? 0, taxCents: change.taxCents ?? 0, test: Boolean(change.test),
  };
}

/** Counts orders, not rows: a repeated webhook or retry is one order. */
export function summarize(items) {
  const real = items.filter((i) => !i.test);
  const firstPerOrder = (kind) => [...new Map(real.filter((i) => i.kind === kind).map((i) => [i.orderName, i])).values()];
  const paid = firstPerOrder('paid');
  const byService = {};
  for (const p of paid) byService[p.to] = (byService[p.to] ?? 0) + 1;
  return {
    requested: firstPerOrder('requested').length,
    paid: paid.length,
    paidShippingCents: paid.reduce((s, p) => s + (p.shippingCents ?? 0), 0),
    byService,
    test: new Set(items.filter((i) => i.test).map((i) => i.orderName)).size,
  };
}

/** One Chat line for the day. */
export function dailyMessage(date, s) {
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const services = Object.entries(s.byService).sort((a, b) => b[1] - a[1]).map(([to, n]) => `${to} ${n}`).join(', ');
  return `Shipping upgrades ${day}: ${s.paid} paid`
    + (s.paid ? ` · +$${centsToAmount(s.paidShippingCents)} shipping (${services})` : '')
    + ` · ${s.requested} requested`
    + (s.test ? ` · ${s.test} test order${s.test === 1 ? '' : 's'} not counted` : '');
}
