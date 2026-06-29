#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Tags } from 'aws-cdk-lib/core';
import { getConfig } from '../lib/config/environments';
import { NetworkStack } from '../lib/stacks/network-stack';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';
import { BillingStack } from '../lib/stacks/billing-stack';
import { IamStack } from '../lib/stacks/iam-stack';

const app = new cdk.App();

// GitHub repository allowed to assume the CI role via OIDC.
const githubRepo =
  (app.node.tryGetContext('githubRepo') as string | undefined) ??
  'ralphboba/StickersBanners-AWS-Infra';

// Select environment via `--context env=dev|prod` (defaults to dev).
const envName = app.node.tryGetContext('env') as string | undefined;
const config = getConfig(envName);

const env: cdk.Environment = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

// Account-level GitHub <-> AWS OIDC trust. Deployed ONCE per account, not per
// env. Pass --context useExistingProvider=true if the GitHub OIDC provider
// already exists in the account.
const githubOidcStack = new GithubOidcStack(app, 'sb-github-oidc', {
  env,
  githubRepo,
  useExistingProvider:
    app.node.tryGetContext('useExistingProvider') === 'true' ||
    app.node.tryGetContext('useExistingProvider') === true,
  description: 'StickersBanners GitHub Actions OIDC trust (account-level)',
});

// Account-level cost guardrail. Free (first two budgets per account) and
// deployed once. Alerts the owner the moment any real AWS charge appears.
const billingStack = new BillingStack(app, 'sb-billing', {
  env,
  alertEmail:
    (app.node.tryGetContext('alertEmail') as string | undefined) ??
    'timothy@stickersbanners.com',
  monthlyLimitUsd: Number(app.node.tryGetContext('monthlyLimitUsd') ?? 5),
  description: 'StickersBanners AWS cost guardrail (account-level)',
});

const networkStack = new NetworkStack(app, `${config.prefix}-network`, {
  env,
  config,
  description: `StickersBanners network layer (${config.env})`,
});

// IAM roles + Parameter Store read access (Week 2). Free to deploy.
const iamStack = new IamStack(app, `${config.prefix}-iam`, {
  env,
  config,
  description: `StickersBanners IAM roles (${config.env})`,
});

// Apply environment tags to every resource in the app.
for (const [key, value] of Object.entries(config.tags)) {
  Tags.of(app).add(key, value);
}

// Silence unused-var lint until later stacks consume these stack outputs.
void networkStack;
void githubOidcStack;
void billingStack;
void iamStack;
