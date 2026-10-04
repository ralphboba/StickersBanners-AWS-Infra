import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeShopifyCredentials } from '../../src/shared/shopify-auth.mjs';

const notFound = () => Object.assign(new Error('nope'), { name: 'ParameterNotFound' });

function secrets(values) {
  const reads = [];
  return {
    reads,
    getSecret: async (group, key) => {
      reads.push(`${group}/${key}`);
      if (!(key in values)) throw notFound();
      return values[key];
    },
  };
}

const APP = { 'shop-domain': 'sb.myshopify.com', 'client-id': 'cid', 'client-secret': 'csecret' };

function tokenServer(tokens) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = tokens.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'number') return { ok: false, status: next, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => next };
    },
  };
}

describe('client credentials grant', () => {
  test('trades the client id and secret for a token at the shop', async () => {
    const s = secrets(APP);
    const srv = tokenServer([{ access_token: 'tok-1', expires_in: 86399, scope: 'read_orders' }]);
    const creds = makeShopifyCredentials({ getSecret: s.getSecret, fetchImpl: srv.fetchImpl, now: () => 0 });
    assert.deepEqual(await creds(), { shop: 'sb.myshopify.com', token: 'tok-1' });
    assert.equal(srv.calls[0].url, 'https://sb.myshopify.com/admin/oauth/access_token');
    assert.equal(srv.calls[0].init.method, 'POST');
    const body = new URLSearchParams(srv.calls[0].init.body);
    assert.equal(body.get('grant_type'), 'client_credentials');
    assert.equal(body.get('client_id'), 'cid');
    assert.equal(body.get('client_secret'), 'csecret');
  });

  test('reuses the token until ten minutes before it expires, then fetches a new one', async () => {
    let t = 0;
    const srv = tokenServer([{ access_token: 'tok-1', expires_in: 3600 }, { access_token: 'tok-2', expires_in: 3600 }]);
    const creds = makeShopifyCredentials({ getSecret: secrets(APP).getSecret, fetchImpl: srv.fetchImpl, now: () => t });
    assert.equal((await creds()).token, 'tok-1');
    t = 49 * 60 * 1000;
    assert.equal((await creds()).token, 'tok-1');
    assert.equal(srv.calls.length, 1);
    t = 51 * 60 * 1000;
    assert.equal((await creds()).token, 'tok-2');
    assert.equal(srv.calls.length, 2);
  });

  test('callers arriving together share one exchange', async () => {
    const srv = tokenServer([{ access_token: 'tok-1', expires_in: 3600 }]);
    const creds = makeShopifyCredentials({ getSecret: secrets(APP).getSecret, fetchImpl: srv.fetchImpl, now: () => 0 });
    const got = await Promise.all([creds(), creds(), creds()]);
    assert.deepEqual(got.map((c) => c.token), ['tok-1', 'tok-1', 'tok-1']);
    assert.equal(srv.calls.length, 1);
  });

  test('a failed exchange throws without the secret in the message, and the next call retries', async () => {
    const srv = tokenServer([401, { access_token: 'tok-2', expires_in: 3600 }]);
    const creds = makeShopifyCredentials({ getSecret: secrets(APP).getSecret, fetchImpl: srv.fetchImpl, now: () => 0 });
    await assert.rejects(creds(), (err) => /HTTP 401/.test(err.message) && !err.message.includes('csecret'));
    assert.equal((await creds()).token, 'tok-2');
  });

  test('a reply without a token is an error, not an empty token', async () => {
    const srv = tokenServer([{ error: 'invalid_client' }]);
    const creds = makeShopifyCredentials({ getSecret: secrets(APP).getSecret, fetchImpl: srv.fetchImpl, now: () => 0 });
    await assert.rejects(creds(), /no token/);
  });
});

describe('static token fallback', () => {
  test('without a client id, the stored admin token is used and nothing is fetched', async () => {
    const s = secrets({ 'shop-domain': 'sb.myshopify.com', 'admin-token': 'shpat_x' });
    const srv = tokenServer([]);
    const creds = makeShopifyCredentials({ getSecret: s.getSecret, fetchImpl: srv.fetchImpl, now: () => 0 });
    assert.deepEqual(await creds(), { shop: 'sb.myshopify.com', token: 'shpat_x' });
    assert.equal(srv.calls.length, 0);
  });

  test('neither credential stored: the call fails', async () => {
    const creds = makeShopifyCredentials({
      getSecret: secrets({ 'shop-domain': 'sb.myshopify.com' }).getSecret, fetchImpl: tokenServer([]).fetchImpl });
    await assert.rejects(creds());
  });

  test('an SSM error other than not-found is not mistaken for "no app"', async () => {
    const creds = makeShopifyCredentials({
      getSecret: async (g, k) => { if (k === 'client-id') throw new Error('AccessDenied'); return 'x'; },
      fetchImpl: tokenServer([]).fetchImpl,
    });
    await assert.rejects(creds(), /AccessDenied/);
  });
});
