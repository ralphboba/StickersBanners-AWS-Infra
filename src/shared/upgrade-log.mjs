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
    ...(change.addOns?.length ? { itemsCents: change.itemsCents ?? 0, addOns: change.addOns.length } : {}),
  };
}

/** Counts orders, not rows: a repeated webhook or retry is one order. */
export function summarize(items) {
  const real = items.filter((i) => !i.test);
  const firstPerOrder = (kind) => [...new Map(real.filter((i) => i.kind === kind).map((i) => [i.orderName, i])).values()];
  const paid = firstPerOrder('paid');
  const byService = {};
  for (const p of paid) if (p.from !== p.to) byService[p.to] = (byService[p.to] ?? 0) + 1;
  return {
    requested: firstPerOrder('requested').length,
    paid: paid.length,
    paidShippingCents: paid.reduce((s, p) => s + (p.shippingCents ?? 0), 0),
    // Orders that added products (Kai, 2026-10-08), and what the products came to.
    addOnOrders: paid.filter((p) => p.addOns > 0).length,
    paidItemsCents: paid.reduce((s, p) => s + (p.itemsCents ?? 0), 0),
    byService,
    test: new Set(items.filter((i) => i.test).map((i) => i.orderName)).size,
  };
}

/** The one-line summary for the day (the email's first line). */
export function dailyMessage(date, s) {
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const services = Object.entries(s.byService).sort((a, b) => b[1] - a[1]).map(([to, n]) => `${to} ${n}`).join(', ');
  return `Shipping upgrades ${day}: ${s.paid} paid`
    + (s.paid ? ` · +$${centsToAmount(s.paidShippingCents)} shipping (${services})` : '')
    + (s.addOnOrders ? ` · ${s.addOnOrders} with add-ons +$${centsToAmount(s.paidItemsCents)}` : '')
    + ` · ${s.requested} requested`
    + (s.test ? ` · ${s.test} test order${s.test === 1 ? '' : 's'} not counted` : '');
}

/**
 * The daily email: subject = the summary, body = the summary plus every order
 * behind it. Paid orders first, then requests not paid that day.
 * @returns {{ subject: string, body: string }}
 */
export function dailyEmail(date, items) {
  const s = summarize(items);
  const line = dailyMessage(date, s);
  const real = items.filter((i) => !i.test);
  const paidOrders = new Map(real.filter((i) => i.kind === 'paid').map((i) => [i.orderName, i]));
  const unpaid = [...new Map(real.filter((i) => i.kind === 'requested' && !paidOrders.has(i.orderName))
    .map((i) => [i.orderName, i])).values()];
  const row = (i) => `  ${i.orderName}  ${i.from} -> ${i.to}  +$${centsToAmount(i.shippingCents ?? 0)}`
    + (i.addOns ? `  + ${i.addOns} add-on${i.addOns === 1 ? '' : 's'} $${centsToAmount(i.itemsCents ?? 0)}` : '');
  const body = [
    line, '',
    `Paid (${paidOrders.size}):`, ...([...paidOrders.values()].map(row)), ...(paidOrders.size ? [] : ['  none']), '',
    `Requested, not paid that day (${unpaid.length}):`, ...unpaid.map(row), ...(unpaid.length ? [] : ['  none']), '',
    `Day: ${date}, New York time. Test orders are not counted.`,
  ].join('\n');
  // SNS caps the subject at 100 characters; the full line is the body's first.
  const day = line.slice('Shipping upgrades '.length, line.indexOf(':'));
  const subject = `Shipping upgrades ${day}: ${s.paid} paid${s.paid ? `, +$${centsToAmount(s.paidShippingCents)}` : ''} (${s.requested} requested)`;
  return { subject: subject.slice(0, 100), body };
}
