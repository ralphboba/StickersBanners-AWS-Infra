import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getConfig } from '../lib/config/environments';
import { DatabaseStack, JOBS_GSI1 } from '../lib/stacks/database-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const stack = new DatabaseStack(app, `${config.prefix}-database`, {
    config,
    env: { account: '123456789012', region: config.region },
  });
  return Template.fromStack(stack);
}

describe('DatabaseStack', () => {
  test('creates one on-demand table named sb-<env>-jobs', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'sb-dev-jobs',
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('uses PK/SK string keys', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    });
  });

  test('defines the GSI1 status-lookup index', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: JOBS_GSI1,
          KeySchema: [
            { AttributeName: 'GSI1PK', KeyType: 'HASH' },
            { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('enables TTL on expiresAt', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('dev: PITR off, table destroyed on delete', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  test('prod: PITR on, table retained on delete', () => {
    const template = synth('prod');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  test('grants read/write to compute roles (incl. the GSI)', () => {
    const app = new cdk.App();
    const config = getConfig('dev');
    const roles = new cdk.Stack(app, 'roles', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const lambdaRole = new iam.Role(roles, 'L', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const ecsRole = new iam.Role(roles, 'E', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    new DatabaseStack(app, 'sb-dev-database', {
      config,
      env: { account: '123456789012', region: 'us-east-1' },
      lambdaRole,
      ecsTaskRole: ecsRole,
    });
    Template.fromStack(roles).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('dynamodb:PutItem')]),
          }),
        ]),
      }),
    });
  });
});
