// What a customer may add to their order from the "Manage my order" page.
//
// Kai (2026-10-08): every product in the Stand / Red Carpets menu, except the
// ones he has taken off the store. So the list is read from Shopify, not kept
// here: the "stands-and-carpets" collection, products that are ACTIVE and
// published to the Online Store (a draft, or one hidden from the store, is one
// he has blocked). A product added to or removed from that collection changes
// the page with no deploy.
//
// Only things that need no artwork: the customer never uploads anything here
// (Linh's rule). So a Stand or Carpet product offers every size, and a printed
// product in the same menu (X-Banner, Retractable Banner) offers only its
// "Stand Only" variant — the "X-Banner Stand" / "Retractable Banner Stand" of
// the menu.

import { shopifyGraphQL } from './shopify-fetch.mjs';
import { toCents } from './money.mjs';

export const ADDON_COLLECTION = 'stands-and-carpets';
const HARDWARE_TYPES = new Set(['stand', 'carpet']);
const CACHE_MS = 10 * 60 * 1000;

const CATALOG = `
  query AddOns($handle: String!) {
    collectionByHandle(handle: $handle) {
      products(first: 100) {
        nodes {
          id title status productType onlineStoreUrl
          featuredImage { url(transform: { maxWidth: 160 }) }
          variants(first: 100) { nodes { id title sku price availableForSale } }
        }
      }
    }
  }
`;

/** Turn the collection into the add-on list. Pure, so the rules are testable. */
export function addOnsFrom(products = []) {
  const out = [];
  for (const p of products) {
    if (p?.status !== 'ACTIVE' || !p?.onlineStoreUrl) continue;   // blocked by Kai
    const hardware = HARDWARE_TYPES.has(String(p.productType ?? '').toLowerCase());
    const variants = (p.variants?.nodes ?? []).filter((v) => v?.availableForSale
      && (hardware || /\bstand\s*only\b/i.test(String(v.title ?? ''))));
    const options = variants.map((v) => ({
      variantId: v.id,
      title: v.title === 'Default Title' ? p.title : v.title,
      sku: v.sku ?? '',
      price: toCents(v.price),
    })).filter((v) => Number.isSafeInteger(v.price) && v.price > 0);
    if (!options.length) continue;
    out.push({ productId: p.id, title: p.title, image: p.featuredImage?.url ?? null, options });
  }
  return out;
}

let cache = { at: 0, list: null };

/** The add-on list, cached for 10 minutes per warm function. Never throws. */
export async function fetchAddOnCatalog({ shop, token, fetchImpl, now = Date.now }) {
  if (cache.list && now() - cache.at < CACHE_MS) return cache.list;
  try {
    const res = await shopifyGraphQL({ shop, token, fetchImpl, query: CATALOG, variables: { handle: ADDON_COLLECTION } });
    const list = addOnsFrom(res?.data?.collectionByHandle?.products?.nodes ?? []);
    cache = { at: now(), list };
    return list;
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'add-on catalog unavailable', err: String(err) }));
    return cache.list ?? [];
  }
}

/** For tests. */
export function __resetAddOnCatalog() { cache = { at: 0, list: null }; }

/** The variants a request may add: each must be on the current list. */
export function resolveAddOns(requested, catalog) {
  const byId = new Map(catalog.flatMap((p) => p.options.map((o) => [o.variantId, { ...o, product: p.title }])));
  const merged = new Map();
  for (const r of Array.isArray(requested) ? requested : []) {
    const qty = Number(r?.quantity);
    if (!Number.isSafeInteger(qty) || qty <= 0) continue;
    const v = byId.get(String(r?.variantId ?? ''));
    if (!v) return { error: 'addon_not_offered' };
    const prev = merged.get(v.variantId);
    merged.set(v.variantId, { ...v, quantity: (prev?.quantity ?? 0) + qty });
  }
  return { addOns: [...merged.values()] };
}
