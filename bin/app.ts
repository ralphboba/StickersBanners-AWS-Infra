#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Tags } from 'aws-cdk-lib/core';
import { getConfig } from '../lib/config/environments';
import { NetworkStack } from '../lib/stacks/network-stack';

const app = new cdk.App();

// Select environment via `--context env=dev|prod` (defaults to dev).
const envName = app.node.tryGetContext('env') as string | undefined;
const config = getConfig(envName);

const env: cdk.Environment = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

const networkStack = new NetworkStack(app, `${config.prefix}-network`, {
  env,
  config,
  description: `StickersBanners network layer (${config.env})`,
});

// Apply environment tags to every resource in the app.
for (const [key, value] of Object.entries(config.tags)) {
  Tags.of(app).add(key, value);
}

// Silence unused-var lint until later stacks consume the network stack outputs.
void networkStack;
