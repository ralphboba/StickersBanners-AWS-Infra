import { DeployEnv } from './types';

/**
 * Single source of truth for the application's credentials.
 *
 * Credentials are stored as **SSM Parameter Store SecureString** parameters
 * (free, KMS-encrypted) under a per-environment path prefix:
 *
 *   /sb/<env>/<group>/<key>      e.g. /sb/dev/orderdesk/api-key
 *
 * IMPORTANT: only the *names/paths* live here and in git. The actual secret
 * VALUES are never committed — they are seeded out-of-band with
 * `scripts/seed-parameters.sh` (which reads a local, git-ignored file) or
 * entered in the AWS console. The repo is public; treat it accordingly.
 */

export interface SecretParam {
  /** Logical group, used as the second path segment. */
  readonly group: string;
  /** Key within the group, used as the final path segment. */
  readonly key: string;
  /** Human description (shown in console + docs). */
  readonly description: string;
}

/**
 * Every credential the legacy system hardcoded, migrated to Parameter Store.
 * Derived from the SBBotExpress / SBImageProcessor environment + integrations.
 */
export const SECRET_PARAMS: readonly SecretParam[] = [
  // OrderDesk API (order polling + record sync)
  { group: 'orderdesk', key: 'api-key', description: 'OrderDesk API key' },
  { group: 'orderdesk', key: 'store-id', description: 'OrderDesk store id' },
  { group: 'orderdesk', key: 'webhook-secret', description: 'Shared secret OrderDesk sends with each webhook (validated by the webhook Lambda)' },

  // Shopify — our own Dev Dashboard app "Manage My Order Button" (never OrderDesk's
  // integration token). Client credentials are traded for a ~24h access token
  // at runtime (src/shared/shopify-auth.mjs); the client secret also verifies
  // the app's orders/paid webhook.
  { group: 'shopify', key: 'shop-domain', description: 'Shopify shop domain (stickersbanners.myshopify.com)' },
  { group: 'shopify', key: 'client-id', description: 'Shopify app Client ID (Dev Dashboard)' },
  { group: 'shopify', key: 'client-secret', description: 'Shopify app Client secret — token exchange + webhook HMAC' },

  // Zendesk (support ticket integration)
  { group: 'zendesk', key: 'subdomain', description: 'Zendesk subdomain (e.g. stickersbanners)' },
  { group: 'zendesk', key: 'email', description: 'Zendesk API user email' },
  { group: 'zendesk', key: 'api-token', description: 'Zendesk API token' },

  // Customer proof approval links (shared/approval-link.mjs). Seeding BOTH of
  // these is the switchover from Linh's portal to ours: with them set, the
  // proof-ready email carries a signed link into our own approval route.
  // Clearing either one falls back to the legacy portal with no deploy.
  { group: 'approval', key: 'link-secret', description: 'HMAC secret signing customer proof-approval links (any long random string; rotating it invalidates outstanding links)' },
  { group: 'approval', key: 'portal-base', description: 'Public URL of our proof approval page, e.g. https://<dashboard-domain>/proof.html — leave unset to keep using proof.stickersbanners.com' },

  // Production-facility FTP (GA/NJ/TX/NV transfers)
  { group: 'ftp', key: 'host', description: 'FTP host (e.g. 64.57.252.252)' },
  { group: 'ftp', key: 'user', description: 'FTP username' },
  { group: 'ftp', key: 'password', description: 'FTP password' },

  // Discord (ops alerts / notifications)
  { group: 'discord', key: 'webhook-url', description: 'Discord webhook URL for alerts' },

  // Google Chat (order notifications: proof-ready / complete / failed)
  { group: 'googlechat', key: 'webhook-url', description: 'Google Chat incoming-webhook URL for order notifications' },

  // Google Chat — one line per paid customer shipping change (src/shared/gchat.mjs)
  { group: 'gchat', key: 'webhook-url', description: 'Google Chat space webhook for paid shipping changes' },
  // Facility spaces: also notified when the order's current Order Desk folder is theirs (optional)
  { group: 'gchat', key: 'webhook-url-GA', description: 'Google Chat GA facility space (paid shipping changes on GA orders)' },
  { group: 'gchat', key: 'webhook-url-NJ', description: 'Google Chat NJ facility space (paid shipping changes on NJ orders)' },
  { group: 'gchat', key: 'webhook-url-TX', description: 'Google Chat TX facility space (paid shipping changes on TX orders)' },

  // Gmail (transactional email via app password)
  { group: 'gmail', key: 'user', description: 'Gmail account address' },
  { group: 'gmail', key: 'app-password', description: 'Gmail app password' },

  // Google service account (CA facility Google Drive uploads)
  { group: 'google', key: 'service-account-json', description: 'Google service account JSON (full file contents)' },
  { group: 'google', key: 'ca-drive-id', description: 'Google Drive folder id that receives CA facility uploads' },
] as const;

/** Path prefix for an environment, e.g. `/sb/dev`. */
export function secretsPrefix(env: DeployEnv): string {
  return `/sb/${env}`;
}

/** Full SSM parameter name for a given secret in an environment. */
export function secretPath(env: DeployEnv, param: SecretParam): string {
  return `${secretsPrefix(env)}/${param.group}/${param.key}`;
}

/**
 * IAM-friendly ARN resource pattern covering every secret in an environment:
 *   arn:aws:ssm:<region>:<account>:parameter/sb/<env>/*
 * Note: the parameter name starts with `/`, and the ARN segment is
 * `parameter` + that name, so there is exactly one slash after `parameter`.
 */
export function secretsArnPattern(env: DeployEnv, region: string, account: string): string {
  return `arn:aws:ssm:${region}:${account}:parameter${secretsPrefix(env)}/*`;
}
