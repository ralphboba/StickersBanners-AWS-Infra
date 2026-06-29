import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getConfig } from '../lib/config/environments';
import { QueueStack } from '../lib/stacks/queue-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const stack = new QueueStack(app, `${config.prefix}-queues`, {
    config,
    env: { account: '123456789012', region: config.region },
  });
  return Template.fromStack(stack);
}

describe('QueueStack', () => {
  test('creates 3 work queues + 3 DLQs (6 total)', () => {
    synth().resourceCountIs('AWS::SQS::Queue', 6);
  });

  test('every queue is FIFO with content-based dedup', () => {
    const template = synth();
    for (const q of Object.values(template.findResources('AWS::SQS::Queue'))) {
      expect(q.Properties.FifoQueue).toBe(true);
      expect(q.Properties.ContentBasedDeduplication).toBe(true);
      expect(q.Properties.QueueName).toMatch(/\.fifo$/);
    }
  });

  test('every queue uses SQS-managed SSE', () => {
    const template = synth();
    for (const q of Object.values(template.findResources('AWS::SQS::Queue'))) {
      expect(q.Properties.SqsManagedSseEnabled).toBe(true);
    }
  });

  test('each work queue has a redrive policy to its DLQ (maxReceive 5)', () => {
    const template = synth();
    const withRedrive = Object.values(template.findResources('AWS::SQS::Queue')).filter(
      (q) => q.Properties.RedrivePolicy,
    );
    expect(withRedrive).toHaveLength(3);
    for (const q of withRedrive) {
      expect(q.Properties.RedrivePolicy.maxReceiveCount).toBe(5);
    }
  });

  test('the named work queues exist', () => {
    const template = synth('dev');
    for (const name of ['sb-dev-intake.fifo', 'sb-dev-ftp.fifo', 'sb-dev-notify.fifo']) {
      template.hasResourceProperties('AWS::SQS::Queue', { QueueName: name });
    }
  });

  test('grants least-privilege send/consume to compute roles', () => {
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
    new QueueStack(app, 'sb-dev-queues', {
      config,
      env: { account: '123456789012', region: 'us-east-1' },
      lambdaRole,
      ecsTaskRole: ecsRole,
    });
    Template.fromStack(roles).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('sqs:SendMessage')]),
          }),
        ]),
      }),
    });
  });
});
