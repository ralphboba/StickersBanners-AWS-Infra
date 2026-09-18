import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface ArtworkCdnStackProps extends cdk.StackProps {
  /** The existing customer-upload bucket. NOT created or owned by this stack. */
  readonly bucketName: string;
  /** The region that bucket actually lives in. */
  readonly bucketRegion: string;
}

/**
 * CloudFront in front of the customer artwork bucket.
 *
 * ## The problem this solves
 *
 * `sticker-banner-large-file-uploads` was created in **eu-north-1 (Stockholm)**
 * on 2025-11-14. Every other bucket in the account is us-east-1, including one
 * created two weeks earlier, and the bucket carries no tags and no policy that
 * would explain the choice — so this reads as a console region-selector slip,
 * not a decision.
 *
 * The files are not small. The bucket holds 2.95 TB across 236,360 objects, and
 * single uploads run to 593 MB. Downloading those from the US means a
 * transatlantic TCP stream.
 *
 * Measured from us-east-1, reading the first 32 MiB of a real 593 MB object:
 *
 *     eu-north-1   1 stream   95 Mbps      8 streams   134 Mbps
 *     us-east-1    1 stream  219 Mbps      8 streams   332 Mbps
 *
 * So the region costs about 2.3x. That is real, but it is NOT what produces the
 * 0.1 Mbps reported from an office connection — the same path measured here at
 * 95 Mbps. The missing factor is packet loss. Single-stream TCP throughput
 * falls off as roughly MSS / (RTT * sqrt(loss)), and the measurement above runs
 * over AWS's own backbone, where loss is negligible. A US office reaching
 * Stockholm crosses public transit at ~120 ms RTT, and at that latency a
 * percent or two of loss is enough to collapse one stream to the hundreds of
 * kbps. A 593 MB file at 0.1 Mbps takes thirteen hours.
 *
 * ## Why CloudFront fixes it, and caching is not the reason
 *
 * Each artwork file is typically fetched once, so the cache hit rate will be
 * low. The win is the path:
 *
 *   - the viewer's TCP connection terminates at a **US edge**, cutting RTT from
 *     ~120 ms to ~15 ms over the viewer's own ISP, where loss barely matters;
 *   - the edge-to-Stockholm leg runs on AWS's backbone — the 95-134 Mbps path
 *     measured above — instead of public transit.
 *
 * That turns a ~1000x problem into the ~2.3x one, without moving a byte. An S3
 * bucket's region cannot be changed, and 236k objects are addressed by
 * `<bucket>.s3.eu-north-1.amazonaws.com` URLs stored on years of OrderDesk
 * orders, so moving the data would break every historical artwork link.
 *
 * ## Deliberately phased
 *
 * The bucket is **public-read today** (`AllowPublicReadUploads`, `Principal:
 * "*"`), which is how those historical URLs resolve at all. This stack does not
 * touch that. Origin Access Control is configured so CloudFront signs its
 * origin requests, but OAC does not require the bucket to be private — it only
 * needs an *additive* read grant (scripts/artwork-cdn-grant.sh). Direct S3 URLs
 * keep working exactly as they do now.
 *
 * Closing public access is a separate, later step, once every consumer reads
 * through the distribution. Coupling it to this change would trade a speed fix
 * for an outage on every old order.
 */
export class ArtworkCdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: ArtworkCdnStackProps) {
    super(scope, id, props);

    const { bucketName, bucketRegion } = props;

    // Imported by name and by its REGIONAL domain. The regional form is what
    // makes a cross-region origin work: the bare `<bucket>.s3.amazonaws.com`
    // would resolve through us-east-1 and redirect, and CloudFront does not
    // follow origin redirects.
    const bucket = s3.Bucket.fromBucketAttributes(this, 'ArtworkBucket', {
      bucketName,
      bucketRegionalDomainName: `${bucketName}.s3.${bucketRegion}.amazonaws.com`,
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `StickersBanners customer artwork (${bucketName} @ ${bucketRegion})`,
      // North America + Europe. The viewers are US staff and US bots; the
      // origin is in Europe. Nothing is served from Asia or South America.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originId: 'artwork-eu-north-1',
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Keys embed an upload timestamp, so an object is never rewritten under
        // the same key. Long TTLs are safe. The cache is a bonus here, not the
        // point — see the class doc.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // GET/HEAD only. Uploads do not go through the CDN, and allowing write
        // methods on a public distribution in front of a public bucket is not a
        // door worth leaving open.
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        // PDFs, PNGs and ZIPs are already compressed; re-compressing costs CPU
        // at the edge and saves nothing.
        compress: false,
      },
    });

    new cdk.CfnOutput(this, 'ArtworkCdnDomain', {
      value: this.distribution.distributionDomainName,
      description: 'Swap this in for the S3 hostname when downloading artwork',
      exportName: 'sb-artwork-cdn-domain',
    });
    new cdk.CfnOutput(this, 'ArtworkCdnArn', {
      value: this.distribution.distributionArn,
      description: 'Needed by scripts/artwork-cdn-grant.sh for the OAC read grant',
      exportName: 'sb-artwork-cdn-arn',
    });
  }
}
