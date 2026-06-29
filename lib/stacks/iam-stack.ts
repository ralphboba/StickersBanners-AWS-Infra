import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvironmentConfig } from '../config/types';
import { secretsArnPattern } from '../config/secrets';

export interface IamStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Least-privilege IAM roles for the compute tiers.
 *
 * Created in Week 2 (Thu). Each role gets only what it needs:
 *  - Lambda execution role: CloudWatch Logs + read its env's SecureString params.
 *  - ECS task role: read its env's SecureString params (app-level AWS access).
 *  - ECS task execution role: pull images + write logs (used by the ECS agent).
 *  - EventBridge role: assume-able by EventBridge (scheduler/rules); concrete
 *    target permissions are attached when the rules are defined (Week 10).
 *
 * S3/SQS/DynamoDB permissions are added in their respective weeks; this stack
 * establishes the roles and the shared Parameter Store read access.
 */
export class IamStack extends cdk.Stack {
  public readonly lambdaExecutionRole: iam.Role;
  public readonly ecsTaskRole: iam.Role;
  public readonly ecsTaskExecutionRole: iam.Role;
  public readonly eventBridgeRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    const { config } = props;
    const env = config.env;

    // Permission to read this environment's SecureString parameters and
    // decrypt them with the SSM-managed KMS key (scoped via kms:ViaService).
    const ssmReadStatement = new iam.PolicyStatement({
      sid: 'ReadEnvSecureStrings',
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [secretsArnPattern(env, this.region, this.account)],
    });
    const kmsDecryptStatement = new iam.PolicyStatement({
      sid: 'DecryptViaSsm',
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
      },
    });

    const secretsReadPolicy = new iam.Policy(this, 'SecretsReadPolicy', {
      policyName: `${config.prefix}-secrets-read`,
      statements: [ssmReadStatement, kmsDecryptStatement],
    });

    // --- Lambda execution role ---
    this.lambdaExecutionRole = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `${config.prefix}-lambda-exec`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'StickersBanners Lambda execution role',
      managedPolicies: [
        // Logs + VPC ENI management (Lambdas run in the VPC private subnets).
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });
    this.lambdaExecutionRole.attachInlinePolicy(secretsReadPolicy);

    // --- ECS task role (application code inside the container) ---
    this.ecsTaskRole = new iam.Role(this, 'EcsTaskRole', {
      roleName: `${config.prefix}-ecs-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'StickersBanners ECS Fargate task role (application permissions)',
    });
    this.ecsTaskRole.attachInlinePolicy(secretsReadPolicy);

    // --- ECS task execution role (used by the ECS agent, not app code) ---
    this.ecsTaskExecutionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      roleName: `${config.prefix}-ecs-exec`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'StickersBanners ECS task execution role (image pull + logs)',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // --- EventBridge role (scheduler/rules target invocation) ---
    this.eventBridgeRole = new iam.Role(this, 'EventBridgeRole', {
      roleName: `${config.prefix}-eventbridge`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
      description: 'StickersBanners EventBridge role (rule/scheduler targets)',
    });

    // Outputs
    new cdk.CfnOutput(this, 'LambdaExecutionRoleArn', {
      value: this.lambdaExecutionRole.roleArn,
      exportName: `${config.prefix}-lambda-exec-arn`,
    });
    new cdk.CfnOutput(this, 'EcsTaskRoleArn', {
      value: this.ecsTaskRole.roleArn,
      exportName: `${config.prefix}-ecs-task-arn`,
    });
    new cdk.CfnOutput(this, 'EcsTaskExecutionRoleArn', {
      value: this.ecsTaskExecutionRole.roleArn,
      exportName: `${config.prefix}-ecs-exec-arn`,
    });
    new cdk.CfnOutput(this, 'EventBridgeRoleArn', {
      value: this.eventBridgeRole.roleArn,
      exportName: `${config.prefix}-eventbridge-arn`,
    });
  }
}
