import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { getConfig } from '../lib/config/environments';
import { SchedulerStack } from '../lib/stacks/scheduler-stack';

function synth(intervalMinutes?: number) {
  const app = new cdk.App();
  const config = getConfig('dev');
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'deps', { env });
  const pollerFn = new lambda.Function(deps, 'Poller', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({});'),
  });
  const stack = new SchedulerStack(app, 'sb-dev-scheduler', {
    config,
    env,
    pollerFn,
    intervalMinutes,
  });
  return Template.fromStack(stack);
}

describe('SchedulerStack', () => {
  test('creates the real-poll and mirror schedules', () => {
    synth().resourceCountIs('AWS::Scheduler::Schedule', 2);
  });

  test('the real process-poll ships DISABLED (go-live is a deliberate flip)', () => {
    synth().hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(15 minutes)',
      State: 'DISABLED',
    });
  });

  test('the display-only mirror sync ships ENABLED', () => {
    synth().hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'sb-dev-mirror-sync',
      State: 'ENABLED',
    });
  });

  test('runs on a 15-minute rate by default', () => {
    synth().hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(15 minutes)',
      FlexibleTimeWindow: { Mode: 'OFF' },
    });
  });

  test('interval is configurable', () => {
    synth(30).hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(30 minutes)',
    });
  });

  test('scheduler execution role is scoped to invoking the poller only', () => {
    const template = synth();
    // Dedicated role trusting scheduler.amazonaws.com
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Principal: { Service: 'scheduler.amazonaws.com' } }),
        ]),
      }),
    });
    // Only lambda:InvokeFunction granted
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'lambda:InvokeFunction' }),
        ]),
      }),
    });
  });
});
