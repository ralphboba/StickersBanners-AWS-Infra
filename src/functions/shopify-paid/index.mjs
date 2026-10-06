// Shopify payment webhook (orders/paid, orders/updated). Logic in core.mjs,
// live dependencies in deps.mjs.

import { getSecret } from '../../shared/secrets.mjs';
import { makePaidHandler } from './core.mjs';
import { paidDeps } from './deps.mjs';

export const handler = makePaidHandler({
  // Webhooks this app subscribes to are signed with the app's Client secret.
  webhookSecret: () => getSecret('shopify', 'client-secret'),
  ...paidDeps,
});
