import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentConfig } from '../config/types';
import { secretsArnPattern } from '../config/secrets';

export interface ComputeStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly jobsTable: dynamodb.ITable;
  readonly intakeQueue: sqs.IQueue;
  readonly notifyQueue: sqs.IQueue;
  /** dzi CloudFront base URL, for the customer proof link in the Zendesk email. */
  readonly proofCdnBase?: string;
  /** OrderDesk folder id the poller pulls ready orders from (QTS). */
  readonly qtsFolderId?: string;
}

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const SRC = path.join(SRC_ROOT, 'functions');

/**
 * Lambda compute layer (Week 5A).
 *
 * The "light work" tier that replaces the Express side of SBBotExpress. These
 * functions run **outside the VPC** — they only talk to AWS APIs (SQS, DynamoDB)
 * and the public internet (OrderDesk), so no NAT Gateway is needed and the tier
 * stays at $0 (free tier: 1M requests/month).
 *
 *   poller          OrderDesk -> clean -> enqueue intake + record in DynamoDB
 *   notify-consumer drains the notify queue -> Discord/email
 *   order-api       read-only order/job status (API Gateway in Week 6)
 *
 * Each function gets its own role with least-privilege grants (no shared
 * god-role); the IAM stack's lambda role is reserved for VPC-bound functions
 * added later.
 */
export class ComputeStack extends cdk.Stack {
  public readonly poller: lambda.Function;
  public readonly notifyConsumer: lambda.Function;
  public readonly orderApi: lambda.Function;
  public readonly webhook: lambda.Function;
  public readonly approval: lambda.Function;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const { config, jobsTable, intakeQueue, notifyQueue } = props;

    const base = {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      memorySize: 256,
      timeout: Duration.seconds(30),
      // X-Ray tracing (Week 9): trace requests across Lambda -> SQS/DDB. CDK
      // adds the X-Ray write permissions to each function role automatically.
      tracing: lambda.Tracing.ACTIVE,
    };

    // --- poller: pull QTS-folder orders from OrderDesk -> clean -> enqueue ---
    // Bundles src root so it can reuse shared/orderdesk (cleanOrder).
    this.poller = new lambda.Function(this, 'Poller', {
      ...base,
      functionName: `${config.prefix}-poller`,
      code: lambda.Code.fromAsset(SRC_ROOT),
      handler: 'functions/poller/index.handler',
      timeout: Duration.seconds(120),
      environment: {
        INTAKE_QUEUE_URL: intakeQueue.queueUrl,
        JOBS_TABLE: jobsTable.tableName,
        SB_ENV: config.env,
        QTS_FOLDER_ID: props.qtsFolderId ?? '',
      },
      description: 'Poll the OrderDesk QTS folder, clean jobs, enqueue intake',
    });
    intakeQueue.grantSendMessages(this.poller);
    jobsTable.grantReadWriteData(this.poller); // read for dedupe, write META
    this.grantSecretsRead(this.poller, config);

    // --- notify-consumer: drains notify queue, emails proof-ready via Zendesk ---
    this.notifyConsumer = new lambda.Function(this, 'NotifyConsumer', {
      ...base,
      functionName: `${config.prefix}-notify-consumer`,
      // Bundle src root so it can import shared/zendesk + shared/secrets.
      code: lambda.Code.fromAsset(SRC_ROOT),
      handler: 'functions/notify-consumer/index.handler',
      description: 'Email the customer (Zendesk) when a proof is ready',
      environment: {
        // dzi CloudFront base for the customer proof link (optional).
        PROOF_CDN_BASE: props.proofCdnBase ?? '',
      },
    });
    // SqsEventSource also grants Receive/Delete on the queue.
    this.notifyConsumer.addEventSource(
      new SqsEventSource(notifyQueue, { batchSize: 10, reportBatchItemFailures: true }),
    );
    this.grantSecretsRead(this.notifyConsumer, config);

    // --- order-api: read-only job status ---
    this.orderApi = new lambda.Function(this, 'OrderApi', {
      ...base,
      functionName: `${config.prefix}-order-api`,
      code: lambda.Code.fromAsset(path.join(SRC, 'order-api')),
      environment: { JOBS_TABLE: jobsTable.tableName },
      description: 'Read-only order/job status lookups',
    });
    jobsTable.grantReadData(this.orderApi);

    // --- webhook: OrderDesk push receiver (validates secret, enqueues intake) ---
    // Bundles src/shared (secrets + routing helpers), so its asset is src root.
    this.webhook = new lambda.Function(this, 'Webhook', {
      ...base,
      functionName: `${config.prefix}-webhook`,
      code: lambda.Code.fromAsset(SRC_ROOT),
      handler: 'functions/webhook/index.handler',
      environment: {
        INTAKE_QUEUE_URL: intakeQueue.queueUrl,
        JOBS_TABLE: jobsTable.tableName,
        SB_ENV: config.env,
      },
      description: 'Receive OrderDesk webhooks, clean + enqueue intake',
    });
    intakeQueue.grantSendMessages(this.webhook);
    jobsTable.grantWriteData(this.webhook);
    this.grantSecretsRead(this.webhook, config);

    // --- approval: resume the paused pipeline on proof approve/reject ---
    this.approval = new lambda.Function(this, 'Approval', {
      ...base,
      functionName: `${config.prefix}-approval`,
      code: lambda.Code.fromAsset(path.join(SRC, 'approval')),
      environment: { JOBS_TABLE: jobsTable.tableName },
      description: 'Proof approve/reject -> resume Step Functions task token',
    });
    jobsTable.grantReadWriteData(this.approval);
    // SendTaskSuccess/Failure aren't resource-scoped to a state machine.
    this.approval.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ResumeWorkflow',
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: ['*'],
      }),
    );

    new cdk.CfnOutput(this, 'PollerName', { value: this.poller.functionName });
    new cdk.CfnOutput(this, 'NotifyConsumerName', { value: this.notifyConsumer.functionName });
    new cdk.CfnOutput(this, 'OrderApiName', { value: this.orderApi.functionName });
    new cdk.CfnOutput(this, 'WebhookName', { value: this.webhook.functionName });
    new cdk.CfnOutput(this, 'ApprovalName', { value: this.approval.functionName });
  }

  /** Read this env's SecureString params + decrypt via the SSM-managed key. */
  private grantSecretsRead(fn: lambda.Function, config: EnvironmentConfig): void {
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadEnvSecureStrings',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [secretsArnPattern(config.env, this.region, this.account)],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'DecryptViaSsm',
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }),
    );
  }
}
