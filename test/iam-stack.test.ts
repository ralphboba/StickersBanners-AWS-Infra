import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config/environments';
import { IamStack } from '../lib/stacks/iam-stack';
import { secretsArnPattern, secretPath, SECRET_PARAMS } from '../lib/config/secrets';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const stack = new IamStack(app, `${config.prefix}-iam`, {
    config,
    env: { account: '123456789012', region: config.region },
  });
  return Template.fromStack(stack);
}

describe('IamStack', () => {
  test('creates four roles (lambda, ecs task, ecs exec, eventbridge)', () => {
    synth().resourceCountIs('AWS::IAM::Role', 4);
  });

  test('roles trust the correct service principals', () => {
    const template = synth();
    for (const svc of [
      'lambda.amazonaws.com',
      'ecs-tasks.amazonaws.com',
      'events.amazonaws.com',
    ]) {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({ Principal: { Service: svc } }),
          ]),
        }),
      });
    }
  });

  test('secrets read policy is scoped to the env parameter path', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['ssm:GetParameter']),
            Resource: secretsArnPattern('dev', 'us-east-1', '123456789012'),
          }),
        ]),
      }),
    });
  });

  test('kms decrypt is restricted via kms:ViaService', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'kms:Decrypt',
            Condition: {
              StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
            },
          }),
        ]),
      }),
    });
  });
});

describe('secrets config', () => {
  test('every parameter path is well-formed (/sb/<env>/<group>/<key>)', () => {
    for (const p of SECRET_PARAMS) {
      expect(secretPath('dev', p)).toMatch(/^\/sb\/dev\/[a-z0-9-]+\/[a-z0-9-]+$/);
    }
  });

  test('arn pattern has exactly one slash after "parameter"', () => {
    const arn = secretsArnPattern('dev', 'us-east-1', '123456789012');
    expect(arn).toBe('arn:aws:ssm:us-east-1:123456789012:parameter/sb/dev/*');
  });
});
