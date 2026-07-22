import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { EnvironmentConfig } from '../config/types';

export interface NetworkStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * Foundational network layer for the StickersBanners AWS migration.
 *
 * Provides:
 *  - A VPC spanning 2 AZs with public + private (egress) subnets.
 *  - Internet Gateway (implicit via public subnets) and NAT Gateway(s) for
 *    private-subnet outbound traffic (OrderDesk/Zendesk/FTP/Discord/Gmail).
 *  - Security Groups for the Lambda, ECS Fargate, and ElastiCache Redis tiers.
 *  - VPC Endpoints (S3, DynamoDB gateway; Secrets Manager, SQS interface) so
 *    AWS-service traffic stays on the AWS backbone and avoids NAT data charges.
 *
 * Compute tiers (Lambda, ECS) and the Redis cluster are defined in later
 * stacks; they import the SGs and VPC published here.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly redisSecurityGroup: ec2.SecurityGroup;
  public readonly vpcEndpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { config } = props;
    const { network } = config;

    // ---------------------------------------------------------------------
    // VPC + subnets + IGW + NAT
    // ---------------------------------------------------------------------
    // With zero NATs (dev, $0), private subnets have no egress: workloads run
    // in the PUBLIC subnets with a public IP instead.
    const hasNat = network.natGateways > 0;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${config.prefix}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(network.cidr),
      maxAzs: network.maxAzs,
      natGateways: network.natGateways,
      // /20 per subnet (~4091 usable IPs) — plenty for Fargate tasks + ENIs.
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 20,
        },
        {
          name: 'private',
          // NAT egress when available; otherwise isolated (Redis etc. only).
          subnetType: hasNat ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 20,
        },
      ],
      // Resolve private DNS for interface endpoints.
      enableDnsHostnames: true,
      enableDnsSupport: true,
    });

    // ---------------------------------------------------------------------
    // Security Groups
    // ---------------------------------------------------------------------

    // Lambda functions (API routes, schedulers). Outbound only by default.
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      securityGroupName: `${config.prefix}-lambda-sg`,
      description: 'StickersBanners Lambda functions (API + schedulers)',
      allowAllOutbound: true,
    });

    // ECS Fargate image-processing services (resize/finish/proof/ftp).
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc: this.vpc,
      securityGroupName: `${config.prefix}-ecs-sg`,
      description: 'StickersBanners ECS Fargate image-processing tasks',
      allowAllOutbound: true,
    });

    // ElastiCache Redis. No outbound needed; ingress restricted below.
    this.redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: this.vpc,
      securityGroupName: `${config.prefix}-redis-sg`,
      description: 'StickersBanners ElastiCache Redis cluster',
      allowAllOutbound: false,
    });

    // Shared SG for interface VPC endpoints — allows HTTPS from the VPC.
    this.vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSg', {
      vpc: this.vpc,
      securityGroupName: `${config.prefix}-vpce-sg`,
      description: 'StickersBanners interface VPC endpoints (HTTPS)',
      allowAllOutbound: false,
    });

    // --- Redis ingress: only from Lambda and ECS on the Redis port (6379) ---
    const REDIS_PORT = 6379;
    this.redisSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(REDIS_PORT),
      'Allow Redis access from Lambda',
    );
    this.redisSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(REDIS_PORT),
      'Allow Redis access from ECS tasks',
    );

    // --- Interface endpoint ingress: HTTPS from Lambda + ECS tiers ---
    this.vpcEndpointSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS to VPC endpoints from Lambda',
    );
    this.vpcEndpointSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS to VPC endpoints from ECS tasks',
    );

    // ---------------------------------------------------------------------
    // VPC Endpoints
    // ---------------------------------------------------------------------

    // Gateway endpoints (free): S3 + DynamoDB, route-table based.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoints (hourly + data cost) for control-plane services so
    // private subnets reach them without traversing the NAT Gateway. Only
    // created alongside NAT (prod): in the $0/no-NAT layout, tasks run in
    // public subnets and reach these services over their public endpoints.
    if (hasNat) {
      const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
        SecretsManagerEndpoint: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        SqsEndpoint: ec2.InterfaceVpcEndpointAwsService.SQS,
      };
      for (const [logicalId, service] of Object.entries(interfaceEndpoints)) {
        this.vpc.addInterfaceEndpoint(logicalId, {
          service,
          securityGroups: [this.vpcEndpointSecurityGroup],
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          privateDnsEnabled: true,
        });
      }
    }

    // ---------------------------------------------------------------------
    // Outputs (consumed by later stacks / for quick inspection)
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${config.prefix}-vpc-id`,
    });
    // With no NAT the "private" tier synthesizes as isolated subnets.
    const privateTier = hasNat ? this.vpc.privateSubnets : this.vpc.isolatedSubnets;
    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: privateTier.map((s) => s.subnetId).join(','),
      exportName: `${config.prefix}-private-subnet-ids`,
    });
    new cdk.CfnOutput(this, 'LambdaSgId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      exportName: `${config.prefix}-lambda-sg-id`,
    });
    new cdk.CfnOutput(this, 'EcsSgId', {
      value: this.ecsSecurityGroup.securityGroupId,
      exportName: `${config.prefix}-ecs-sg-id`,
    });
    new cdk.CfnOutput(this, 'RedisSgId', {
      value: this.redisSecurityGroup.securityGroupId,
      exportName: `${config.prefix}-redis-sg-id`,
    });
  }
}
