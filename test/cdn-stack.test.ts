import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config/environments';
import { CdnStack } from '../lib/stacks/cdn-stack';

function synth() {
  const app = new cdk.App();
  const config = getConfig('dev');
  const stack = new CdnStack(app, 'sb-dev-cdn', {
    config,
    env: { account: '123456789012', region: config.region },
  });
  return Template.fromStack(stack);
}

describe('CdnStack', () => {
  test('creates one CloudFront distribution', () => {
    synth().resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('uses Origin Access Control (not legacy OAI)', () => {
    synth().resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  test('redirects viewers to HTTPS', () => {
    synth().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      }),
    });
  });

  test('references the dzi bucket by deterministic name (no cross-stack import)', () => {
    const template = synth();
    const dist = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
    const domain = JSON.stringify(dist.Properties.DistributionConfig.Origins);
    expect(domain).toContain('sb-dev-dzi-123456789012.s3.us-east-1.amazonaws.com');
  });

  test('uses the cheapest price class', () => {
    synth().hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ PriceClass: 'PriceClass_100' }),
    });
  });
});
