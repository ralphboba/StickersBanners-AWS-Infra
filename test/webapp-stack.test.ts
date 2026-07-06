import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config/environments';
import { WebappStack } from '../lib/stacks/webapp-stack';

function synth() {
  const app = new cdk.App();
  const config = getConfig('dev');
  const stack = new WebappStack(app, 'sb-dev-webapp', {
    config,
    env: { account: '123456789012', region: 'us-east-1' },
    apiBase: 'https://api.example.com',
    userPoolClientId: 'client123',
    cdnBase: 'https://tiles.example.com',
  });
  return Template.fromStack(stack);
}

describe('WebappStack', () => {
  test('hosts a private bucket behind CloudFront (OAC)', () => {
    const template = synth();
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true },
    });
  });

  test('serves index.html at the root and falls back for SPA routes', () => {
    const template = synth();
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [
          { ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' },
          { ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' },
        ],
      },
    });
  });

  test('deploys the site contents (BucketDeployment custom resource)', () => {
    // s3-deployment renders a Custom::CDKBucketDeployment resource.
    synth().resourceCountIs('Custom::CDKBucketDeployment', 1);
  });
});
