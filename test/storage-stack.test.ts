import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config/environments';
import { StorageStack } from '../lib/stacks/storage-stack';

function synth(envName: 'dev' | 'prod' = 'dev') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const stack = new StorageStack(app, `${config.prefix}-storage`, {
    config,
    env: { account: '123456789012', region: config.region },
  });
  return Template.fromStack(stack);
}

describe('StorageStack', () => {
  test('creates the five pipeline buckets', () => {
    synth().resourceCountIs('AWS::S3::Bucket', 5);
  });

  test('every bucket blocks all public access', () => {
    const template = synth();
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets)).toHaveLength(5);
    for (const b of Object.values(buckets)) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  test('every bucket is SSE-S3 encrypted', () => {
    const template = synth();
    for (const b of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect(b.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0]).toEqual({
        ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
      });
    }
  });

  test('every bucket enforces TLS (aws:SecureTransport deny)', () => {
    const template = synth();
    const policies = template.findResources('AWS::S3::BucketPolicy');
    expect(Object.keys(policies)).toHaveLength(5);
    for (const p of Object.values(policies)) {
      const stmts = p.Properties.PolicyDocument.Statement as any[];
      const denyTls = stmts.find(
        (s) =>
          s.Effect === 'Deny' &&
          s.Condition?.Bool?.['aws:SecureTransport'] === 'false',
      );
      expect(denyTls).toBeDefined();
    }
  });

  test('every bucket aborts incomplete multipart uploads after 7 days', () => {
    const template = synth();
    for (const b of Object.values(template.findResources('AWS::S3::Bucket'))) {
      const rules = b.Properties.LifecycleConfiguration.Rules as any[];
      const abort = rules.find((r) => r.AbortIncompleteMultipartUpload);
      expect(abort.AbortIncompleteMultipartUpload.DaysAfterInitiation).toBe(7);
    }
  });

  test('only the uploads bucket has CORS', () => {
    const template = synth();
    const withCors = Object.values(template.findResources('AWS::S3::Bucket')).filter(
      (b) => b.Properties.CorsConfiguration,
    );
    expect(withCors).toHaveLength(1);
    expect(withCors[0].Properties.BucketName).toMatch(/uploads/);
  });

  test('dev buckets are destroyed on stack deletion', () => {
    const template = synth('dev');
    template.allResources('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
    });
  });

  test('prod buckets are retained on stack deletion', () => {
    const template = synth('prod');
    template.allResources('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
    });
  });

  test('grants are wired to compute roles when provided', () => {
    const app = new cdk.App();
    const config = getConfig('dev');
    const iamStack = new cdk.Stack(app, 'roles', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const iam = require('aws-cdk-lib/aws-iam');
    const lambdaRole = new iam.Role(iamStack, 'L', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const ecsRole = new iam.Role(iamStack, 'E', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const stack = new StorageStack(app, 'sb-dev-storage', {
      config,
      env: { account: '123456789012', region: 'us-east-1' },
      lambdaRole,
      ecsTaskRole: ecsRole,
    });
    // Grants land on the roles' policies, which live in the IAM stack.
    Template.fromStack(iamStack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([Match.stringLikeRegexp('s3:GetObject')]),
          }),
        ]),
      }),
    });
    expect(Object.keys(stack.buckets)).toHaveLength(5);
  });
});
