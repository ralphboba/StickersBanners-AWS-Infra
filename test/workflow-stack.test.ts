import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { getConfig } from '../lib/config/environments';
import { WorkflowStack } from '../lib/stacks/workflow-stack';

function build() {
  const app = new cdk.App();
  const config = getConfig('dev');
  const env = { account: '123456789012', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'deps', { env });

  const vpc = new ec2.Vpc(deps, 'Vpc');
  const securityGroup = new ec2.SecurityGroup(deps, 'Sg', { vpc });
  const cluster = new ecs.Cluster(deps, 'Cluster', { vpc });

  const taskDefinitions: Record<string, ecs.FargateTaskDefinition> = {};
  for (const key of ['resize', 'finish', 'proof']) {
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
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });

  test('definition runs ECS tasks synchronously and waits for human approval', () => {
    const json = JSON.stringify(build().toJSON());
    expect(json).toContain('ecs:runTask.sync');
    expect(json).toContain('sqs:sendMessage.waitForTaskToken');
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
});
