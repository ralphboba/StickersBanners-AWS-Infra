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

  // Zendesk (support ticket integration)
  { group: 'zendesk', key: 'subdomain', description: 'Zendesk subdomain (e.g. stickersbanners)' },
  { group: 'zendesk', key: 'email', description: 'Zendesk API user email' },
  { group: 'zendesk', key: 'api-token', description: 'Zendesk API token' },

  // Production-facility FTP (GA/NJ/TX/NV transfers)
  { group: 'ftp', key: 'host', description: 'FTP host (e.g. 64.57.252.252)' },
  { group: 'ftp', key: 'user', description: 'FTP username' },
  { group: 'ftp', key: 'password', description: 'FTP password' },

  // Discord (ops alerts / notifications)
  { group: 'discord', key: 'webhook-url', description: 'Discord webhook URL for alerts' },

  // Gmail (transactional email via app password)
  { group: 'gmail', key: 'user', description: 'Gmail account address' },
  { group: 'gmail', key: 'app-password', description: 'Gmail app password' },

  // Google service account (CA facility Google Drive uploads)
  { group: 'google', key: 'service-account-json', description: 'Google service account JSON (full file contents)' },
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
