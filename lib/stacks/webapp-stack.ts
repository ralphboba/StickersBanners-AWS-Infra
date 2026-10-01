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

    // The customer page (web/my-order.html) calls /api/my-order… on its own
    // origin, and the confirmation-email button links to /my-order. One viewer-
    // request function serves both: /my-order -> /my-order.html, and /api/x ->
    // /x for the API Gateway origin below (its routes have no /api prefix).
    const paths = new cloudfront.Function(this, 'PathRewrite', {
      comment: 'my-order page alias + strip /api for the HTTP API',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline([
        'function handler(event) {',
        '  var r = event.request;',
        "  if (r.uri === '/my-order' || r.uri === '/my-order/') r.uri = '/my-order.html';",
        "  else if (r.uri.indexOf('/api/') === 0) r.uri = r.uri.substring(4);",
        '  return r;',
        '}',
      ].join('\n')),
    });
    const rewrite = [{ function: paths, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }];

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `StickersBanners staff dashboard (${config.env})`,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: rewrite,
      },
      additionalBehaviors: {
        // The HTTP API, same origin as the page: no CORS, nothing cached, the
        // query string (order + token) and body passed through untouched.
        '/api/*': {
          origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', apiBase))),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: rewrite,
        },
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

    new cdk.CfnOutput(this, 'MyOrderUrl', {
      value: `https://${this.distribution.distributionDomainName}/my-order`,
      description: 'Customer "Manage my order" page (add ?o=<order>&s=<order_status_url>)',
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Give this URL to staff — sign in and go',
      exportName: `${config.prefix}-dashboard-url`,
    });
  }
}
