import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getConfig } from '../lib/config/environments';
import { NetworkStack } from '../lib/stacks/network-stack';

function synth(envName: 'dev' | 'prod') {
  const app = new cdk.App();
  const config = getConfig(envName);
  const stack = new NetworkStack(app, `${config.prefix}-network`, {
    config,
    env: { account: '123456789012', region: config.region },
  });
  // Mirror bin/app.ts: tags are applied at the app level.
  for (const [key, value] of Object.entries(config.tags)) {
    cdk.Tags.of(app).add(key, value);
  }
  return Template.fromStack(stack);
}

describe('NetworkStack', () => {
  test('creates a VPC with the configured dev CIDR', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.10.0.0/16',
    });
  });

  test('dev has zero NAT Gateways ($0), prod uses two (HA)', () => {
    expect(Object.keys(synth('dev').findResources('AWS::EC2::NatGateway')).length).toBe(0);
    expect(Object.keys(synth('prod').findResources('AWS::EC2::NatGateway')).length).toBe(2);
  });

  test('creates public and private subnets across two AZs', () => {
    const template = synth('dev');
    // 2 public + 2 private = 4 subnets.
    template.resourceCountIs('AWS::EC2::Subnet', 4);
  });

  test('creates Lambda, ECS, Redis, and VPC endpoint security groups', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::EC2::SecurityGroup', 4);
  });

  test('Redis SG allows ingress only on port 6379', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      FromPort: 6379,
      ToPort: 6379,
      IpProtocol: 'tcp',
    });
  });

  test('creates S3 + DynamoDB gateway endpoints', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });

  test('interface endpoints only exist alongside NAT (prod 2, dev 0)', () => {
    const count = (env: 'dev' | 'prod') =>
      Object.values(synth(env).findResources('AWS::EC2::VPCEndpoint')).filter(
        (r) => r.Properties?.VpcEndpointType === 'Interface',
      ).length;
    expect(count('dev')).toBe(0); // $0 layout: public-subnet egress instead
    expect(count('prod')).toBe(2); // Secrets Manager + SQS
  });

  test('tags propagate to resources', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'Environment', Value: 'dev' }),
        Match.objectLike({ Key: 'Project', Value: 'StickersBanners' }),
      ]),
    });
  });
});
