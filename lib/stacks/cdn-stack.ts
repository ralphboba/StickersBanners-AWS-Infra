import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { EnvironmentConfig } from '../config/types';

export interface CdnStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

/**
 * CDN (Week 11) — CloudFront in front of the private `dzi` bucket.
 *
 * The proof viewer (OpenSeadragon-style) requests many small Deep Zoom tiles
 * per view, so a CDN cache is essential. The bucket stays private (block all
 * public access); CloudFront reads it via **Origin Access Control (OAC)** and
 * the bucket grants read to this distribution's ARN (wired in the storage stack
 * to keep the dependency acyclic).
 *
 * The `dzi` bucket is referenced by its **deterministic name** (no CFN import),
 * so this stack does not depend on the storage stack — the OAC read policy
 * points storage -> cdn only.
 *
 * CloudFront's "Always Free" tier (1 TB out + 10M req/month) => $0 at this
 * volume. Default `*.cloudfront.net` cert (free); custom domain + ACM later.
 */
export class CdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    const { config } = props;

    const bucketName = `${config.prefix}-dzi-${this.account}`;
    const dziBucket = s3.Bucket.fromBucketAttributes(this, 'DziBucket', {
      bucketName,
      bucketRegionalDomainName: `${bucketName}.s3.${this.region}.amazonaws.com`,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `StickersBanners DZI proof tiles (${config.env})`,
      // Cheapest edge footprint (North America + Europe) — enough for facilities.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(dziBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Tiles are immutable → long-TTL managed cache policy.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // CORS for the browser tile viewer.
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT,
      },
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront domain serving the DZI proof tiles',
      exportName: `${config.prefix}-dzi-cdn-domain`,
    });
    new cdk.CfnOutput(this, 'DistributionArn', {
      value: this.distribution.distributionArn,
      exportName: `${config.prefix}-dzi-cdn-arn`,
    });
  }
}
