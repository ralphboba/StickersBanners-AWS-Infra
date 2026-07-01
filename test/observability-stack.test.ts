import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { getConfig } from '../lib/config/environments';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

function synth() {
  const app = new cdk.App();
  const config = getConfig('dev');
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'deps', { env });

  const fifo = (id: string) => new sqs.Queue(deps, id, { fifo: true });
  const fn = (id: string) =>
    new lambda.Function(deps, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
  const stateMachine = new sfn.StateMachine(deps, 'SM', {
    definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(deps, 'P')),
  });

  const stack = new ObservabilityStack(app, 'sb-dev-observability', {
    config,
    env,
    deadLetterQueues: { intake: fifo('IntakeDlq'), ftp: fifo('FtpDlq'), notify: fifo('NotifyDlq') },
    intakeQueue: fifo('Intake'),
    lambdas: { webhook: fn('Webhook'), poller: fn('Poller'), approval: fn('Approval') },
    stateMachine,
  });
  return Template.fromStack(stack);
}

describe('ObservabilityStack', () => {
  test('creates an SNS topic with no subscription (attached later)', () => {
    const template = synth();
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::SNS::Subscription', 0);
  });

  test('creates 8 alarms (3 DLQ + 3 Lambda + SF failed + intake backlog)', () => {
    synth().resourceCountIs('AWS::CloudWatch::Alarm', 8);
  });

  test('every alarm notifies the SNS topic', () => {
    const template = synth();
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    expect(Object.keys(alarms)).toHaveLength(8);
    for (const a of Object.values(alarms)) {
      expect(a.Properties.AlarmActions).toBeDefined();
      expect(a.Properties.AlarmActions.length).toBeGreaterThan(0);
    }
  });

  test('creates one dashboard', () => {
    synth().resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  test('DLQ alarms fire on any visible message', () => {
    synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
    });
  });
});
