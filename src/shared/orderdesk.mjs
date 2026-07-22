// OrderDesk order parsing (no AWS deps — unit-testable, reused by webhook/poller).
//
// Verified against the live OrderDesk API (store 784): line-item dimensions,
// finishing, and artwork live in `variation_list` (not `metadata`); payment
// state is `payment_status`. Handles the messy real finishing vocabulary.

import { routeOrder } from './routing.mjs';

/** Map an OrderDesk order JSON into our cleaned "job" shape. */
export function cleanOrder(order) {
  const items = (order.order_items ?? []).map((it) => {
    const vl = it.variation_list ?? {};
    const sku = it.code ?? vl.SKU;
    const uploads = collectUploads(vl);
    return {
      sku,
      name: it.name,
      quantity: Number(it.quantity ?? 1),
      width: num(vl.WIDTH),
      height: num(vl.HEIGHT),
      unit: inferUnit(vl.WIDTH, vl.HEIGHT, sku),
      finishingRaw: vl['FINISHING OPTIONS'],
      finishingObj: mapFinishing(vl['FINISHING OPTIONS']),
      artworkUrl: uploads[0],
      artworkUrls: uploads,
    };
  });

  const shipping = {
    state: order.shipping?.state,
    postalCode: order.shipping?.postal_code,
    method: order.shipping_method,
    name: [order.shipping?.first_name, order.shipping?.last_name].filter(Boolean).join(' '),
  };

  const routing = routeOrder(shipping); // dictionaries seeded later -> UNROUTED for now

  return {
    orderName: String(order.source_id ?? order.id ?? ''),
    createdAt: toIso(order.date_added),
    folder: order.folder_name,
    financialStatus: order.payment_status,
    customer: { email: order.email, name: shipping.name },
    shipping,
    routing,
    needsProof: wantsProof(order),
    totals: {
      subtotal: num(order.product_total),
      grandTotal: num(order.order_total),
      currency: order.currency ?? 'USD',
    },
    items,
    source: { orderDeskId: String(order.id ?? '') },
  };
}

/** All "UPLOADED FILE", "UPLOADED FILE 1..N" values, in order, non-empty. */
function collectUploads(vl) {
  return Object.keys(vl)
    .filter((k) => k.toUpperCase().startsWith('UPLOADED FILE'))
    .sort()
    .map((k) => vl[k])
    .filter((v) => typeof v === 'string' && v.trim().length > 0);
}

const IN_UNIT_SKUS = ['SKUPB', 'SKUXB', 'SKU-543'];
function inferUnit(w, h, sku) {
  const s = `${w ?? ''} ${h ?? ''}`.toLowerCase();
  if (s.includes('in') || IN_UNIT_SKUS.includes(sku)) return 'in';
  return 'ft';
}

/**
 * Robustly map an OrderDesk "FINISHING OPTIONS" string to a finishingObj.
 *
 * Real values are messy — parentheses, plural "Pockets", double spaces,
 * "Finishing options =" prefixes, lowercase, "&"/"/" separators. Normalize
 * then classify by keyword so every real variant maps correctly.
 */
export function mapFinishing(raw) {
  if (!raw) return {};
  let t = String(raw).toLowerCase();
  t = t.replace(/^.*finishing options\s*=\s*/, '');
  t = t.replace(/[()]/g, ' ').replace(/[/,]/g, ' ').replace(/&/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  const has = (s) => t.includes(s);

  if (has('no hem') && has('no grommet')) return {};

  if (has('pole pocket')) {
    let code = 'PPTO';
    if (has('top') && has('bottom')) code = 'PPTB';
    else if (has('bottom')) code = 'PPBO';
    else if (has('top')) code = 'PPTO';
    else if (has('both') || has('sides') || (has('left') && has('right'))) code = 'PPS';
    else if (has('left')) code = 'PPL';
    else if (has('right')) code = 'PPR';
    return { specialFinishing: code };
  }

  if (has('grommet')) {
    const isOnly = has('only') || has('no hem');
    return { grommets: { sides: ['top', 'left', 'right', 'bottom'], ...(isOnly ? { isOnly: true } : {}) } };
  }

  if (has('cut only')) return { descSuf: 'CO' };
  if (has('hem')) return { descSuf: 'HO' };
  return {};
}

function wantsProof(order) {
  const parts = [order.customer_note, order.internal_note];
  for (const it of order.order_items ?? []) {
    const vl = it.variation_list ?? {};
    parts.push(vl['SPECIAL INSTRUCTIONS'], vl['PROOF'], vl['Proof Options']);
  }
  return parts.filter(Boolean).join(' ').toLowerCase().includes('proof');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toIso(v) {
  const d = v ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
