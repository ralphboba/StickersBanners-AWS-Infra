import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getConfig } from '../lib/config/environments';
import { EcsStack } from '../lib/stacks/ecs-stack';

function synth(envName: 'dev' | 'prod' = 'dev', withSg = false) {
  const app = new cdk.App();
  const config = getConfig(envName);
  const deps = new cdk.Stack(app, 'deps', {
    env: { account: '123456789012', region: config.region },
  });
  const vpc = new ec2.Vpc(deps, 'Vpc');
  const taskRole = new iam.Role(deps, 'TaskRole', {
    assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
  });

  const stack = new EcsStack(app, `${config.prefix}-ecs`, {
    config,
    env: { account: '123456789012', region: config.region },
    vpc,
    taskRole,
    ...(withSg ? { securityGroup: new ec2.SecurityGroup(deps, 'Sg', { vpc }) } : {}),
  });
  return Template.fromStack(stack);
}

describe('EcsStack', () => {
  test('creates one Fargate cluster', () => {
    synth().resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('creates four task definitions and four ECR repos', () => {
    const template = synth();
    template.resourceCountIs('AWS::ECS::TaskDefinition', 4);
    template.resourceCountIs('AWS::ECR::Repository', 4);
  });

  test('creates NO running service (idle cost = $0)', () => {
    synth().resourceCountIs('AWS::ECS::Service', 0);
  });

  test('task definitions are Fargate-only', () => {
    const template = synth();
    for (const td of Object.values(template.findResources('AWS::ECS::TaskDefinition'))) {
      expect(td.Properties.RequiresCompatibilities).toEqual(['FARGATE']);
    }
  });

  test('ECR repos keep only the last 10 images', () => {
    const template = synth();
    for (const repo of Object.values(template.findResources('AWS::ECR::Repository'))) {
      const policyText = repo.Properties.LifecyclePolicy.LifecyclePolicyText as string;
      expect(policyText).toContain('"countNumber":10');
    }
  });

  test('prod retains ECR repos; dev destroys them', () => {
    synth('prod').allResources('AWS::ECR::Repository', { DeletionPolicy: 'Retain' });
    synth('dev').allResources('AWS::ECR::Repository', { DeletionPolicy: 'Delete' });
  });

  test('Linh comparison: dev only, hourly, read-only script, email to Kai', () => {
    const dev = synth('dev', true);
    dev.resourceCountIs('AWS::Scheduler::Schedule', 1);
    dev.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(1 hour)' });
    dev.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'sb-dev-linh-compare',
      ContainerDefinitions: [{ Command: ['python', 'linh_compare.py'] }],
    });
    dev.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'kai@stickersbanners.com' });
    // The compare task gets no PRODUCTION_TRANSFER / FTP_BASE_PATH: it never runs the transfer code.
    const td = Object.values(dev.findResources('AWS::ECS::TaskDefinition'))
      .find((r) => r.Properties.Family === 'sb-dev-linh-compare')!;
    const env = td.Properties.ContainerDefinitions[0].Environment.map((e: { Name: string }) => e.Name);
    expect(env).not.toContain('PRODUCTION_TRANSFER');

    const prod = synth('prod', true);
    prod.resourceCountIs('AWS::Scheduler::Schedule', 0);
    prod.resourceCountIs('AWS::SNS::Topic', 0);
  });
});
