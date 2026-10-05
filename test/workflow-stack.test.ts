import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { getConfig } from '../lib/config/environments';
import { WorkflowStack } from '../lib/stacks/workflow-stack';

function build({ withMove = false } = {}) {
  const app = new cdk.App();
  const config = getConfig('dev');
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'deps', { env });

  const vpc = new ec2.Vpc(deps, 'Vpc');
  const securityGroup = new ec2.SecurityGroup(deps, 'Sg', { vpc });
  const cluster = new ecs.Cluster(deps, 'Cluster', { vpc });

  const taskDefinitions: Record<string, ecs.FargateTaskDefinition> = {};
  // 'ftp' is the Transfer step (FTP for GA/NJ/TX/NV, Google Drive for CA).
  // Omitting it here made every test in this file crash on defaultContainer.
  for (const key of ['resize', 'finish', 'proof', 'ftp']) {
    const td = new ecs.FargateTaskDefinition(deps, `${key}Task`);
    td.addContainer(`${key}C`, { image: ecs.ContainerImage.fromRegistry('public.ecr.aws/amazonlinux/amazonlinux:latest') });
    taskDefinitions[key] = td;
  }

  const jobsTable = new dynamodb.Table(deps, 'Jobs', {
    partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  });
  const fifo = (id: string) => new sqs.Queue(deps, id, { fifo: true });

  const stack = new WorkflowStack(app, 'sb-dev-workflow', {
    config,
    env,
    cluster,
    vpc,
    securityGroup,
    taskDefinitions,
    jobsTable,
    intakeQueue: fifo('Intake'),
    ftpQueue: fifo('Ftp'),
    notifyQueue: fifo('Notify'),
    ...(withMove ? {
      orderDeskMoveFn: new lambda.Function(deps, 'Move', {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      }),
    } : {}),
  });
  return Template.fromStack(stack);
}

describe('WorkflowStack', () => {
  test('creates one Standard state machine', () => {
    const template = build();
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
    });
  });

  test('starter Lambda is wired to the intake queue', () => {
    const template = build();
    // starter + request-approval
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  test('definition runs ECS tasks synchronously and waits for human approval', () => {
    const json = JSON.stringify(build().toJSON());
    expect(json).toContain('ecs:runTask.sync');
    expect(json).toContain('lambda:invoke.waitForTaskToken');
    expect(json).toContain('dynamodb:updateItem');
  });

  test('state machine role may run tasks, update the table and send messages', () => {
    const json = JSON.stringify(build().toJSON());
    expect(json).toContain('ecs:RunTask');
    expect(json).toContain('dynamodb:UpdateItem');
    expect(json).toContain('sqs:SendMessage');
  });

  test('starter role may start executions', () => {
    expect(JSON.stringify(build().toJSON())).toContain('states:StartExecution');
  });

  describe('OrderDesk folder moves (Linh, 2026-10-05)', () => {
    /** The state machine's states, parsed out of the synthesized definition. */
    function states(withMove: boolean): Record<string, any> {
      const sm = Object.values(build({ withMove }).findResources('AWS::StepFunctions::StateMachine'))[0];
      const parts = sm.Properties.DefinitionString['Fn::Join'][1]
        .map((p: unknown) => (typeof p === 'string' ? p : 'X')).join('');
      return JSON.parse(parts).States;
    }

    test('without the mover the pipeline is exactly as before', () => {
      const s = states(false);
      expect(Object.keys(s).filter((k) => k.startsWith('MoveTo'))).toEqual([]);
      expect(s.NotifyProofReady.Next).toBe('WaitForApproval');
    });

    test('proof sent -> Proofing, approved -> Pending Review, delivered -> facility', () => {
      const s = states(true);
      expect(s.NotifyProofReady.Next).toBe('MoveToProofing');
      expect(s.MoveToProofing.Next).toBe('WaitForApproval');
      expect(s.WaitForApproval.Next).toBe('MoveToPendingReview');
      expect(s.MoveToPendingReview.Next).toBe('RouteChoice');
      expect(s.Transfer.Next).toBe('MoveToFacility');
      expect(s.MoveToFacility.Next).toBe('Notify');
    });

    test('a move can never stop or change the print job', () => {
      const s = states(true);
      for (const [id, next] of [['MoveToProofing', 'WaitForApproval'],
        ['MoveToPendingReview', 'RouteChoice'], ['MoveToFacility', 'Notify']]) {
        expect(s[id].ResultPath).toBeNull();
        expect(s[id].Catch).toEqual([{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: next }]);
      }
    });
  });
});
