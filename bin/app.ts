#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Tags } from 'aws-cdk-lib/core';
import { getConfig } from '../lib/config/environments';
import { NetworkStack } from '../lib/stacks/network-stack';
import { GithubOidcStack } from '../lib/stacks/github-oidc-stack';
import { BillingStack } from '../lib/stacks/billing-stack';
import { IamStack } from '../lib/stacks/iam-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { QueueStack } from '../lib/stacks/queue-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { EcsStack } from '../lib/stacks/ecs-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { WorkflowStack } from '../lib/stacks/workflow-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';
import { SchedulerStack } from '../lib/stacks/scheduler-stack';
import { CdnStack } from '../lib/stacks/cdn-stack';
import { WebappStack } from '../lib/stacks/webapp-stack';

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

// CDN (Week 11): CloudFront in front of the private dzi bucket (OAC). Created
// before storage so its ARN can be granted read on the bucket without a cycle;
// it references the bucket by deterministic name, so it has no dep on storage.
const cdnStack = new CdnStack(app, `${config.prefix}-cdn`, {
  env,
  config,
  description: `StickersBanners DZI CDN (${config.env})`,
});

// S3 storage layer (Week 3). Empty buckets are $0 under the free tier; the
// compute roles get least-privilege access wired here.
const storageStack = new StorageStack(app, `${config.prefix}-storage`, {
  env,
  config,
  lambdaRole: iamStack.lambdaExecutionRole,
  ecsTaskRole: iamStack.ecsTaskRole,
  dziDistributionArn: cdnStack.distribution.distributionArn,
  description: `StickersBanners S3 storage layer (${config.env})`,
});

// DynamoDB job-state table (Week 4A). Replaces Redis jobData. $0 while idle
// (on-demand). Compute roles get least-privilege read/write here.
const databaseStack = new DatabaseStack(app, `${config.prefix}-database`, {
  env,
  config,
  lambdaRole: iamStack.lambdaExecutionRole,
  ecsTaskRole: iamStack.ecsTaskRole,
  description: `StickersBanners DynamoDB layer (${config.env})`,
});

// SQS queues (Week 4B). Real durable/retry-prone queues only (intake/ftp/
// notify) + DLQs; schedulers and orchestration come later via EventBridge /
// Step Functions. Free tier => $0. Compute roles get least-privilege access.
const queueStack = new QueueStack(app, `${config.prefix}-queues`, {
  env,
  config,
  lambdaRole: iamStack.lambdaExecutionRole,
  ecsTaskRole: iamStack.ecsTaskRole,
  description: `StickersBanners SQS queues (${config.env})`,
});

// Lambda compute layer (Week 5A). Runs outside the VPC; free tier => $0.
// Wires the poller/notify/api functions to the queues + jobs table.
const computeStack = new ComputeStack(app, `${config.prefix}-compute`, {
  env,
  config,
  jobsTable: databaseStack.jobsTable,
  intakeQueue: queueStack.queues['intake'],
  notifyQueue: queueStack.queues['notify'],
  proofCdnBase: `https://${cdnStack.distribution.distributionDomainName}`,
  description: `StickersBanners Lambda compute (${config.env})`,
});

// ECS Fargate layer (Week 5B). Cluster + ECR + task definitions only (no
// running service) => $0 idle. Tasks run on demand via Step Functions (Week 10).
const ecsStack = new EcsStack(app, `${config.prefix}-ecs`, {
  env,
  config,
  vpc: networkStack.vpc,
  taskRole: iamStack.ecsTaskRole,
  description: `StickersBanners ECS Fargate compute (${config.env})`,
});

// Cognito authentication (Week 6). Free up to 50k MAU => $0.
const authStack = new AuthStack(app, `${config.prefix}-auth`, {
  env,
  config,
  description: `StickersBanners Cognito auth (${config.env})`,
});

// HTTP API front door (Week 6): public OrderDesk webhook + Cognito-protected
// order status. Free tier => $0.
const apiStack = new ApiStack(app, `${config.prefix}-api`, {
  env,
  config,
  webhookFn: computeStack.webhook,
  orderApiFn: computeStack.orderApi,
  approvalFn: computeStack.approval,
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  description: `StickersBanners HTTP API (${config.env})`,
});

// Order pipeline orchestration (Week 7): Step Functions Standard state machine
// wiring intake -> resize/finish/proof -> approval -> transfer/notify. ~$3/mo
// at 9k orders; ECS runs on demand (no idle cost).
const workflowStack = new WorkflowStack(app, `${config.prefix}-workflow`, {
  env,
  config,
  cluster: ecsStack.cluster,
  vpc: networkStack.vpc,
  securityGroup: networkStack.ecsSecurityGroup,
  taskDefinitions: ecsStack.taskDefinitions,
  jobsTable: databaseStack.jobsTable,
  intakeQueue: queueStack.queues['intake'],
  ftpQueue: queueStack.queues['ftp'],
  notifyQueue: queueStack.queues['notify'],
  description: `StickersBanners order pipeline (${config.env})`,
});

// Observability (Week 9): alarms + dashboard + X-Ray. Alarms notify an SNS
// topic with no subscription yet (owner attaches email/Discord later). $0.
const observabilityStack = new ObservabilityStack(app, `${config.prefix}-observability`, {
  env,
  config,
  deadLetterQueues: queueStack.deadLetterQueues,
  intakeQueue: queueStack.queues['intake'],
  lambdas: {
    webhook: computeStack.webhook,
    poller: computeStack.poller,
    approval: computeStack.approval,
  },
  stateMachine: workflowStack.stateMachine,
  description: `StickersBanners observability (${config.env})`,
});

// Scheduling (Week 10): EventBridge Scheduler fallback poll. Ships DISABLED
// (poller logic is still a skeleton); flip on after seeding credentials. $0.
const schedulerStack = new SchedulerStack(app, `${config.prefix}-scheduler`, {
  env,
  config,
  pollerFn: computeStack.poller,
  description: `StickersBanners schedules (${config.env})`,
});

// Staff dashboard hosting: serves web/index.html on CloudFront with its config
// generated at deploy time, so non-technical staff just visit a URL and sign in.
const webappStack = new WebappStack(app, `${config.prefix}-webapp`, {
  env,
  config,
  apiBase: apiStack.httpApi.apiEndpoint,
  userPoolClientId: authStack.userPoolClient.userPoolClientId,
  cdnBase: `https://${cdnStack.distribution.distributionDomainName}`,
  description: `StickersBanners staff dashboard hosting (${config.env})`,
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
void storageStack;
void databaseStack;
void queueStack;
void computeStack;
void ecsStack;
void authStack;
void apiStack;
void workflowStack;
void observabilityStack;
void schedulerStack;
void cdnStack;
void webappStack;
