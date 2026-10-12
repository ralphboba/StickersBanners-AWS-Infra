import { resolveLiveSwitches } from '../lib/config/live-switches';

const ctx = (o: Record<string, string>) => (k: string) => o[k];

describe('live switches (shipping change + add-ons)', () => {
  test('dev with no context: both stay ON (a deploy that forgets them cannot switch customers off)', () => {
    expect(resolveLiveSwitches('dev', ctx({}))).toEqual({ shippingChangeTestOrders: undefined, shippingChangeLive: true, addOnOrders: '*' });
  });
  test('dev: only an explicit off turns them off', () => {
    const r = resolveLiveSwitches('dev', ctx({ shippingChange: 'off', addOns: 'off' }));
    expect(r.shippingChangeLive).toBe(false);
    expect(r.addOnOrders).toBe('');
  });
  test('dev: a named list narrows to those orders', () => {
    const r = resolveLiveSwitches('dev', ctx({ testOrders: 'S64262', addOnOrders: 'S67397' }));
    expect(r).toEqual({ shippingChangeTestOrders: 'S64262', shippingChangeLive: false, addOnOrders: 'S67397' });
  });
  test('the old explicit contexts still mean the same', () => {
    expect(resolveLiveSwitches('dev', ctx({ shippingChange: 'live', addOns: 'live' })))
      .toEqual({ shippingChangeTestOrders: undefined, shippingChangeLive: true, addOnOrders: '*' });
  });
  test('prod: off unless named', () => {
    expect(resolveLiveSwitches('prod', ctx({}))).toEqual({ shippingChangeTestOrders: undefined, shippingChangeLive: false, addOnOrders: undefined });
    expect(resolveLiveSwitches('prod', ctx({ shippingChange: 'live', addOns: 'live' })).addOnOrders).toBe('*');
  });
});
