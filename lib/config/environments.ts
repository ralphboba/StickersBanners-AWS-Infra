import { DeployEnv, EnvironmentConfig } from './types';

/**
 * Per-environment configuration.
 *
 * The active environment is selected at synth time via CDK context:
 *   npx cdk synth --context env=dev
 *   npx cdk deploy --context env=prod
 *
 * Region defaults to us-east-1 because CloudFront + ACM certs for the proof
 * viewer must live there, and the existing production FTP/Drive integrations
 * are us-east oriented.
 */
const DEFAULT_REGION = 'us-east-1';

const environments: Record<DeployEnv, EnvironmentConfig> = {
  dev: {
    env: 'dev',
    region: DEFAULT_REGION,
    prefix: 'sb-dev',
    network: {
      cidr: '10.10.0.0/16',
      maxAzs: 2,
      // Single NAT Gateway in dev to keep costs down (~$32/mo each).
      natGateways: 1,
    },
    tags: {
      Project: 'StickersBanners',
      Environment: 'dev',
      ManagedBy: 'CDK',
    },
  },
  prod: {
    env: 'prod',
    region: DEFAULT_REGION,
    prefix: 'sb-prod',
    network: {
      cidr: '10.20.0.0/16',
      maxAzs: 2,
      // One NAT Gateway per AZ for high availability in production.
      natGateways: 2,
    },
    tags: {
      Project: 'StickersBanners',
      Environment: 'prod',
      ManagedBy: 'CDK',
    },
  },
};

/**
 * Resolve the active environment config from CDK context.
 * Defaults to `dev` when `--context env=` is not provided.
 */
export function getConfig(envName?: string): EnvironmentConfig {
  const key = (envName ?? 'dev') as DeployEnv;
  const config = environments[key];
  if (!config) {
    throw new Error(
      `Unknown environment "${envName}". Valid values: ${Object.keys(environments).join(', ')}`,
    );
  }
  return config;
}
