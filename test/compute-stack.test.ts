import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { getConfig } from '../lib/config/environments';
import { ComputeStack } from '../lib/stacks/compute-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  // Dependencies live in their own stack (mirrors the real app wiring).
  const deps = new cdk.Stack(app, 'deps', {
    env: { account: '123456789012', region: config.region },
  });
  const jobsTable = new dynamodb.Table(deps, 'Jobs', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });
  const intakeQueue = new sqs.Queue(deps, 'Intake', { fifo: true });
  const notifyQueue = new sqs.Queue(deps, 'Notify', { fifo: true });

  const stack = new ComputeStack(app, `${config.prefix}-compute`, {
    config,
    env: { account: '123456789012', region: config.region },
    jobsTable,
    intakeQueue,
    notifyQueue,
  });
  return Template.fromStack(stack);
}

describe('ComputeStack', () => {
  test('creates exactly the expected Lambda functions', () => {
    // Named rather than counted so adding a function is a deliberate edit here
    // and the failure says which one appeared.
    const names = Object.values(synth().findResources('AWS::Lambda::Function'))
      .map((fn) => fn.Properties.FunctionName)
      .sort();
    expect(names).toEqual([
      'sb-dev-approval',
      'sb-dev-demo-feeder',
      'sb-dev-notify-consumer',
      'sb-dev-order-api',
      'sb-dev-poller',
      'sb-dev-webhook',
    ]);
  });

  test('functions run on Node 22 and are not VPC-bound', () => {
    const template = synth();
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
      expect(fn.Properties.Runtime).toBe('nodejs22.x');
      expect(fn.Properties.VpcConfig).toBeUndefined();
    }
  });

  test('notify-consumer is wired to an SQS event source', () => {
    synth().resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  test('poller may send to the intake queue', () => {
    synth().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('sqs:SendMessage')]),
          }),
        ]),
      }),
    });
  });

  test('functions that need secrets get scoped SSM read', () => {
    synth().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ssm:GetParameter']),
            Resource: 'arn:aws:ssm:us-east-1:123456789012:parameter/sb/dev/*',
          }),
        ]),
      }),
    });
  });
});
