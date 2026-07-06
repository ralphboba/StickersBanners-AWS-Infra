import * as cdk from 'aws-cdk-lib/core';
import { RemovalPolicy } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';
import { EnvironmentConfig } from '../config/types';

export interface WebappStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /** HTTP API base URL (apiStack.httpApi.apiEndpoint). */
  readonly apiBase: string;
  /** Cognito app client id (authStack.userPoolClient). */
  readonly userPoolClientId: string;
  /** DZI CloudFront domain for proof links (cdnStack), optional. */
  readonly cdnBase?: string;
}

/**
 * Staff dashboard hosting (post-Week-12).
 *
 * Serves `web/index.html` as a real website so **non-technical staff just visit
 * a URL and sign in** — no file editing, no config. The dashboard's settings
 * (API URL, Cognito client id, CDN) are generated into `config.json` **at
 * deploy time** and uploaded next to the page, so there is nothing to fill in
 * by hand.
 *
 * Private S3 bucket behind CloudFront (OAC), SPA-style (404/403 -> index.html).
 * Static hosting on the free tier => $0.
 */
export class WebappStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebappStackProps) {
    super(scope, id, props);

    const { config, apiBase, userPoolClientId, cdnBase } = props;

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${config.prefix}-dashboard-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, // just built artifacts; redeployable
      autoDeleteObjects: true,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `StickersBanners staff dashboard (${config.env})`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      // Single-page app: unknown paths fall back to index.html.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // Upload the page + a generated config.json (deploy-time substituted).
    new s3deploy.BucketDeployment(this, 'DeployDashboard', {
      destinationBucket: siteBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'], // invalidate cache on redeploy
      sources: [
        s3deploy.Source.asset(path.join(__dirname, '..', '..', 'web')),
        s3deploy.Source.jsonData('config.json', {
          region: this.region,
          apiBase,
          userPoolClientId,
          cdnBase: cdnBase ?? '',
        }),
      ],
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Give this URL to staff — sign in and go',
      exportName: `${config.prefix}-dashboard-url`,
    });
  }
}
