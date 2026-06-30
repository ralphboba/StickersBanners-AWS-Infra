import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { getConfig } from '../lib/config/environments';
import { EcsStack } from '../lib/stacks/ecs-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
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
});
