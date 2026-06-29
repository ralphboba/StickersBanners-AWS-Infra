import * as cdk from 'aws-cdk-lib/core';
import { RemovalPolicy } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvironmentConfig } from '../config/types';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /**
   * Compute roles (from the IAM stack) granted least-privilege table access.
   * Optional so the stack still synthesizes/tests standalone.
   */
  readonly lambdaRole?: iam.IRole;
  readonly ecsTaskRole?: iam.IRole;
}

/** Name of the status-lookup GSI. */
export const JOBS_GSI1 = 'GSI1';

/**
 * DynamoDB layer (Week 4A).
 *
 * Replaces the legacy Redis `jobData` store with a single, durable, serverless
 * table. Redis lived in the single PC's RAM, so an in-progress order's state
 * vanished on a crash; DynamoDB persists to disk, auto-backs-up, and scales.
 *
 * Single-table design:
 *   PK = ORDER#<shopify-name>   e.g. ORDER#S42166
 *   SK = META | STEP#<stage>    order summary + per-stage processing state
 *
 * GSI1 answers "show me every order currently in <status>":
 *   GSI1PK = STATUS#<status>    GSI1SK = <createdAt ISO>
 *
 * On-demand billing means it costs **$0** while idle (free tier: 25 GB +
 * generous on-demand request allowance).
 */
export class DatabaseStack extends cdk.Stack {
  public readonly jobsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { config, lambdaRole, ecsTaskRole } = props;
    const isProd = config.env === 'prod';

    this.jobsTable = new dynamodb.Table(this, 'JobsTable', {
      tableName: `${config.prefix}-jobs`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      // Pay only for what we use — $0 while idle.
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // AWS-owned key encryption (default, free — no KMS charge).
      encryption: dynamodb.TableEncryption.DEFAULT,
      // Auto-expire completed orders we no longer need (set `expiresAt` epoch).
      timeToLiveAttribute: 'expiresAt',
      // 35-day continuous backups in prod; off in dev to stay at $0.
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: isProd,
      },
      // Protect prod data on stack deletion; dev is disposable.
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Status-lookup index: "all orders in STATUS#processing", newest first.
    this.jobsTable.addGlobalSecondaryIndex({
      indexName: JOBS_GSI1,
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Least-privilege grants ---
    // Both tiers read and write job state (Lambda on intake/API, ECS as it
    // advances each processing stage). grantReadWriteData covers the GSI too.
    if (lambdaRole) this.jobsTable.grantReadWriteData(lambdaRole);
    if (ecsTaskRole) this.jobsTable.grantReadWriteData(ecsTaskRole);

    new cdk.CfnOutput(this, 'JobsTableName', {
      value: this.jobsTable.tableName,
      description: 'Order/job state table (Redis jobData replacement)',
      exportName: `${config.prefix}-jobs-table`,
    });
    new cdk.CfnOutput(this, 'JobsTableArn', {
      value: this.jobsTable.tableArn,
      exportName: `${config.prefix}-jobs-table-arn`,
    });
  }
}
