import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { getConfig } from '../lib/config/environments';
import { ComputeStack } from '../lib/stacks/compute-stack';

function synth(envName: 'dev' | 'prod' = 'dev', shippingChangeTestOrders?: string) {
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
    shippingChangeTestOrders,
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
      'sb-dev-order-change-request',
      'sb-dev-order-status-api',
      'sb-dev-poller',
      'sb-dev-proof-approval',
      'sb-dev-shipping-change-expiry',
      'sb-dev-shopify-paid',
      'sb-dev-upgrade-report',
      'sb-dev-webhook',
    ]);
  });

  test('the shipping-change functions ship with both write switches off', () => {
    const fns = Object.values(synth().findResources('AWS::Lambda::Function'))
      .filter((fn) => /order-change-request|shopify-paid|shipping-change-expiry/.test(fn.Properties.FunctionName));
    expect(fns).toHaveLength(3);
    for (const fn of fns) {
      expect(fn.Properties.Environment.Variables.SHOPIFY_WRITES).toBe('disabled');
      expect(fn.Properties.Environment.Variables.ORDERDESK_UPGRADE_WRITES).toBe('disabled');
    }
  });

  test('a test list arms the writes for those orders only', () => {
    const fns = Object.values(synth('dev', 's64262').findResources('AWS::Lambda::Function'))
      .filter((fn) => /order-change-request|shopify-paid|shipping-change-expiry/.test(fn.Properties.FunctionName));
    for (const fn of fns) {
      const v = fn.Properties.Environment.Variables;
      expect(v.SHOPIFY_WRITES).toBe('enabled');
      expect(v.ORDERDESK_UPGRADE_WRITES).toBe('enabled');
      expect(v.WRITE_ONLY_ORDERS).toBe('S64262');
    }
    // The public read-only function is never armed.
    const status = Object.values(synth('dev', 'S64262').findResources('AWS::Lambda::Function'))
      .find((fn) => fn.Properties.FunctionName === 'sb-dev-order-status-api');
    expect(status?.Properties.Environment.Variables.SHOPIFY_WRITES).toBeUndefined();
  });

  test('without a test list there is no WRITE_ONLY_ORDERS, and a bad list is refused', () => {
    for (const fn of Object.values(synth().findResources('AWS::Lambda::Function'))) {
      expect(fn.Properties.Environment?.Variables?.WRITE_ONLY_ORDERS).toBeUndefined();
    }
    expect(() => synth('dev', '*')).toThrow(/order names/);
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

  test('the customer approval function can approve but cannot reject', () => {
    // Linh: no disapprove. The customer route is public, so the guarantee is
    // enforced in IAM as well as in code — SendTaskFailure is never granted to
    // it, and only the staff approval function holds that permission.
    const policies = Object.values(synth().findResources('AWS::IAM::Policy'));
    const sids = (sid: string) =>
      policies.filter((p) =>
        (p.Properties.PolicyDocument.Statement as { Sid?: string }[])
          .some((st) => st.Sid === sid));

    const [customer] = sids('ResumeWorkflowOnCustomerApproval');
    expect(customer).toBeDefined();
    const statement = (customer.Properties.PolicyDocument.Statement as { Sid?: string, Action: unknown }[])
      .find((st) => st.Sid === 'ResumeWorkflowOnCustomerApproval')!;
    expect(statement.Action).toBe('states:SendTaskSuccess');

    // The staff function keeps both — its routes are behind Cognito.
    const [staff] = sids('ResumeWorkflow');
    const staffStatement = (staff.Properties.PolicyDocument.Statement as { Sid?: string, Action: unknown }[])
      .find((st) => st.Sid === 'ResumeWorkflow')!;
    expect(staffStatement.Action).toEqual(['states:SendTaskSuccess', 'states:SendTaskFailure']);
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

  test('the public order-status function can read the table but not write it', () => {
    // It is reachable without authentication. Even past a bug in the token
    // check, the role itself must not allow a change to any order.
    const template = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const logicalId = Object.keys(fns).find(
      (k) => fns[k].Properties.Handler === 'functions/order-status-api/index.handler',
    );
    expect(logicalId).toBeDefined();

    const roleRef = fns[logicalId!].Properties.Role['Fn::GetAtt'][0];
    const policies = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleRef));
    const actions = policies.flatMap((p: any) =>
      p.Properties.PolicyDocument.Statement.flatMap((st: any) =>
        (Array.isArray(st.Action) ? st.Action : [st.Action]) as string[]));

    expect(actions).toEqual(expect.arrayContaining(['dynamodb:GetItem']));
    for (const forbidden of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem']) {
      expect(actions).not.toContain(forbidden);
    }
  });

  test('it can read this environment\'s secrets, for the Shopify quote', () => {
    const template = synth();
    const fns = template.findResources('AWS::Lambda::Function');
    const logicalId = Object.keys(fns).find(
      (k) => fns[k].Properties.Handler === 'functions/order-status-api/index.handler',
    );
    const roleRef = fns[logicalId!].Properties.Role['Fn::GetAtt'][0];
    const actions = Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleRef))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement.flatMap((st: any) =>
        (Array.isArray(st.Action) ? st.Action : [st.Action]) as string[]));
    expect(actions).toEqual(expect.arrayContaining(['ssm:GetParameter']));
  });

  test('the daily upgrade report runs every morning, New York time, emails Kai only, read-only on the table', () => {
    const t = synth();
    t.resourceCountIs('AWS::SNS::Subscription', 1);
    t.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'kai@stickersbanners.com' });
    t.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'sb-dev-upgrade-report',
      ScheduleExpression: 'cron(52 8 * * ? *)',
      ScheduleExpressionTimezone: 'America/New_York',
      State: 'ENABLED',
    });
    const env = Object.values(t.findResources('AWS::Lambda::Function'))
      .find((fn) => fn.Properties.FunctionName === 'sb-dev-upgrade-report')!.Properties.Environment.Variables;
    expect(env.REPORT_TOPIC_ARN).toBeDefined();
    expect(env.SHOPIFY_WRITES).toBeUndefined();
    expect(env.ORDERDESK_UPGRADE_WRITES).toBeUndefined();
  });

  test('the two customer-facing functions get 1 GB and a 5-minute no-op warm-up', () => {
    const t = synth();
    const fns = Object.values(t.findResources('AWS::Lambda::Function'));
    for (const name of ['sb-dev-order-status-api', 'sb-dev-order-change-request']) {
      expect(fns.find((f) => f.Properties.FunctionName === name)!.Properties.MemorySize).toBe(1024);
      t.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: `${name}-warm`, ScheduleExpression: 'rate(5 minutes)', State: 'ENABLED',
        Target: Match.objectLike({ Input: JSON.stringify({ warmup: true }) }),
      });
    }
  });
});
