#!/usr/bin/env node
// Subscribe the deployed payment handler to Shopify (orders/paid + orders/updated).
//
//   node scripts/shopify-webhooks.mjs list   [--env dev]
//   node scripts/shopify-webhooks.mjs add    --url https://<api>/webhook/shopify-paid [--order S64262] [--env dev]
//   node scripts/shopify-webhooks.mjs remove [--env dev]     (every subscription of this app)
//
// The subscriptions belong to our app ("Manage My Order Button"), so Shopify
// signs them with its client secret — the key shopify-paid verifies with.
// --order filters both subscriptions to that one order (test runs), so other
// customers' orders are not sent. Credentials from SSM with your AWS login.

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const mode = process.argv[2];
if (!['list', 'add', 'remove'].includes(mode)) {
  console.error('usage: list | add --url <https://…/webhook/shopify-paid> [--order S64262] | remove   [--env dev]');
  process.exit(1);
}
process.env.SB_ENV = arg('env', 'dev');

const { getSecret } = await import('../src/shared/secrets.mjs');
const { makeShopifyCredentials } = await import('../src/shared/shopify-auth.mjs');
const { fetchOrderByName } = await import('../src/shared/shopify-orders.mjs');
const creds = makeShopifyCredentials({ getSecret });

async function admin(query, variables) {
  const { shop, token } = await creds();
  const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const LIST = `{ webhookSubscriptions(first: 50) { nodes { id topic filter endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`;
const list = async () => (await admin(LIST)).webhookSubscriptions.nodes;

if (mode === 'list') {
  const subs = await list();
  if (!subs.length) console.log('no subscriptions');
  for (const s of subs) console.log(`${s.topic.padEnd(16)} ${s.endpoint?.callbackUrl ?? s.endpoint?.__typename}${s.filter ? `  filter: ${s.filter}` : ''}  (${s.id})`);
}

if (mode === 'add') {
  const url = arg('url');
  if (!/^https:\/\/.+\/webhook\/shopify-paid$/.test(url ?? '')) throw new Error('--url must be https://…/webhook/shopify-paid');
  let filter;
  const order = arg('order');
  if (order) {
    const o = await fetchOrderByName({ ...(await creds()), orderName: order.replace(/^#/, '') });
    if (!o) throw new Error(`order ${order} not found`);
    filter = `id:${String(o.id).split('/').pop()}`;
  }
  for (const topic of ['ORDERS_PAID', 'ORDERS_UPDATED']) {
    const d = await admin(`mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } } }`,
    { topic, sub: { uri: url, format: 'JSON', ...(filter ? { filter } : {}) } });
    const r = d.webhookSubscriptionCreate;
    if (r.userErrors.length) throw new Error(`${topic}: ${JSON.stringify(r.userErrors)}`);
    console.log(`added ${topic}${filter ? ` (${filter})` : ''}`);
  }
}

if (mode === 'remove') {
  for (const s of await list()) {
    await admin('mutation($id: ID!){ webhookSubscriptionDelete(id: $id){ deletedWebhookSubscriptionId userErrors{ message } } }', { id: s.id });
    console.log(`removed ${s.topic} (${s.id})`);
  }
}
