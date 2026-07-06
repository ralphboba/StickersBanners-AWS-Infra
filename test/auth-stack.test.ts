import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config/environments';
import { AuthStack } from '../lib/stacks/auth-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const stack = new AuthStack(app, `${config.prefix}-auth`, {
    config,
    env: { account: '123456789012', region: config.region },
  });
  return Template.fromStack(stack);
}

describe('AuthStack', () => {
  test('creates one user pool and one app client', () => {
    const template = synth();
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  test('self-signup is disabled (admin-created accounts only)', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
    });
  });

  test('prod enforces a strong password policy (>= 12, all classes)', () => {
    synth('prod').hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    });
  });

  test('dev relaxes the policy for testing (6 chars, no complexity)', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 6, RequireSymbols: false }) },
    });
  });

  test('signs in by username (not email)', () => {
    // username sign-in => UsernameAttributes is not set to email
    const pool = Object.values(synth().findResources('AWS::Cognito::UserPool'))[0];
    expect(pool.Properties.UsernameAttributes ?? []).not.toContain('email');
  });

  test('app client has no secret (public SPA client)', () => {
    synth().hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
    });
  });

  test('prod retains the user pool; dev destroys it', () => {
    synth('prod').hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
    synth('dev').hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
  });
});
