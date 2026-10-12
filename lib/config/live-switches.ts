/**
 * The customer-facing switches that are live in dev: the shipping change
 * (Kai, 2026-10-04) and add-ons (Kai, 2026-10-11). In dev they stay ON when a
 * deploy does not mention them (Kai, 2026-10-12: a deploy from another branch
 * without the contexts switched add-ons off for every customer), so only an
 * explicit word turns them off:
 *   --context shippingChange=off   /   --context addOns=off
 * A named list still narrows them to those orders:
 *   --context testOrders=S64262    /   --context addOnOrders=S64262
 * prod: off unless named, as before.
 */
export interface LiveSwitches {
  shippingChangeTestOrders?: string;
  shippingChangeLive: boolean;
  addOnOrders?: string;
}

export function resolveLiveSwitches(env: string, ctx: (key: string) => unknown): LiveSwitches {
  const dev = env === 'dev';
  const testOrders = ctx('testOrders') as string | undefined;
  const shippingChange = ctx('shippingChange');
  const addOns = ctx('addOns');
  const addOnOrders = ctx('addOnOrders') as string | undefined;
  return {
    shippingChangeTestOrders: testOrders,
    shippingChangeLive: shippingChange === 'live' || (dev && shippingChange !== 'off' && !testOrders),
    addOnOrders: addOns === 'live' ? '*'
      : addOns === 'off' ? ''
      : addOnOrders ?? (dev ? '*' : undefined),
  };
}
