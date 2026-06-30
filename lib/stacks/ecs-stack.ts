import * as cdk from 'aws-cdk-lib/core';
import { RemovalPolicy } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvironmentConfig } from '../config/types';

export interface EcsStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly taskRole: iam.IRole;
}

interface ServiceSpec {
  readonly id: string;
  /** Logical name; becomes the ECR repo + task family suffix. */
  readonly key: string;
  readonly purpose: string;
  readonly cpu: number;
  readonly memoryMiB: number;
}

/**
 * ECS Fargate compute layer (Week 5B).
 *
 * The "heavy work" tier that replaces SBImageProcessor's Python/FastAPI
 * services. We define the **cluster, an ECR repo, a CloudWatch log group, and a
 * Fargate task definition per service** — but deliberately create **no running
 * service**, so there is **$0** idle cost. Tasks are launched on demand
 * (`RunTask`) by Step Functions in Week 10; image processing only costs money
 * while a job is actually running.
 *
 * Container images don't exist yet, so task definitions point at the `latest`
 * tag of an (empty) ECR repo as a placeholder until images are pushed.
 */
export class EcsStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly repositories: Record<string, ecr.Repository> = {};
  public readonly taskDefinitions: Record<string, ecs.FargateTaskDefinition> = {};

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const { config, vpc, taskRole } = props;
    const isProd = config.env === 'prod';

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${config.prefix}-cluster`,
      vpc,
      // containerInsights stays off — it streams to CloudWatch ($). Enable later.
    });

    const specs: ServiceSpec[] = [
      { id: 'Resize', key: 'resize', purpose: 'PIL resize, ft/in -> px @72dpi, TIFF', cpu: 1024, memoryMiB: 2048 },
      { id: 'Finish', key: 'finish', purpose: 'print finishing (grommets/pole pockets/etc.)', cpu: 1024, memoryMiB: 2048 },
      { id: 'Proof', key: 'proof', purpose: 'proof/preview generation', cpu: 512, memoryMiB: 1024 },
      { id: 'Ftp', key: 'ftp', purpose: 'FTP transfer to production facilities', cpu: 512, memoryMiB: 1024 },
    ];

    for (const spec of specs) {
      // ECR repo: keep the last 10 images, scan on push.
      const repo = new ecr.Repository(this, `${spec.id}Repo`, {
        repositoryName: `${config.prefix}-${spec.key}`,
        imageScanOnPush: true,
        lifecycleRules: [{ maxImageCount: 10, description: 'keep last 10 images' }],
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        emptyOnDelete: !isProd,
      });
      this.repositories[spec.key] = repo;

      const logGroup = new logs.LogGroup(this, `${spec.id}Logs`, {
        logGroupName: `/sb/${config.env}/ecs/${spec.key}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      });

      const taskDef = new ecs.FargateTaskDefinition(this, `${spec.id}Task`, {
        family: `${config.prefix}-${spec.key}`,
        cpu: spec.cpu,
        memoryLimitMiB: spec.memoryMiB,
        taskRole, // app permissions (S3/SQS/DynamoDB/secrets), shared IAM role
        // executionRole is auto-created per task def (gets ECR pull + log write
        // grants here); reusing the shared IAM exec role would create a
        // cross-stack dependency cycle.
      });

      taskDef.addContainer(`${spec.id}Container`, {
        containerName: spec.key,
        // Placeholder: the `latest` tag of the (currently empty) repo.
        image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: spec.key, logGroup }),
        environment: { SB_ENV: config.env },
      });

      this.taskDefinitions[spec.key] = taskDef;

      new cdk.CfnOutput(this, `${spec.id}RepoUri`, {
        value: repo.repositoryUri,
        description: spec.purpose,
        exportName: `${config.prefix}-${spec.key}-repo-uri`,
      });
    }

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      exportName: `${config.prefix}-cluster-name`,
    });
  }
}
