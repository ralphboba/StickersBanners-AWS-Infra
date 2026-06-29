import * as cdk from 'aws-cdk-lib/core';
import { Duration, RemovalPolicy } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvironmentConfig } from '../config/types';

export interface StorageStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /**
   * Compute roles (from the IAM stack) to wire least-privilege bucket access to.
   * Optional so the stack still synthesizes/tests standalone.
   */
  readonly lambdaRole?: iam.IRole;
  readonly ecsTaskRole?: iam.IRole;
}

/** Access level a role gets on a bucket. */
type Access = 'rw' | 'read';

interface BucketSpec {
  /** Construct id. */
  readonly id: string;
  /** Suffix used in the physical bucket name (`<prefix>-<key>-<account>`). */
  readonly key: string;
  /** What it holds (for the description/output). */
  readonly purpose: string;
  /** Allow browser CORS PUT/GET (direct presigned uploads). */
  readonly cors?: boolean;
  /** Move objects to Infrequent Access after 90 days (intermediate artifacts). */
  readonly transitionToIa?: boolean;
  /** Lambda (API/orchestration) access level. */
  readonly lambda: Access;
  /** ECS Fargate (image processing) access level. */
  readonly ecs: Access;
}

/**
 * S3 storage layer (Week 3).
 *
 * Replaces the legacy local disk (C:/D:/E:) of the single Windows PC with five
 * purpose-built buckets. The whole layer is **$0** while empty (the S3 free
 * tier covers 5 GB / 20k GET / 2k PUT for the first 12 months); the only cost
 * driver is stored bytes once the pipeline runs.
 *
 * Access split mirrors the architecture: Lambda owns the API surface
 * (presigned uploads, invoices), ECS Fargate does the image processing
 * (reads uploads, writes processed/finished/dzi).
 */
export class StorageStack extends cdk.Stack {
  public readonly buckets: Record<string, s3.Bucket> = {};

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config, lambdaRole, ecsTaskRole } = props;
    const isProd = config.env === 'prod';

    const specs: BucketSpec[] = [
      {
        id: 'Uploads',
        key: 'uploads',
        purpose: 'raw customer artwork uploads (presigned browser PUT)',
        cors: true,
        transitionToIa: true,
        lambda: 'rw',
        ecs: 'read',
      },
      {
        id: 'Processed',
        key: 'processed',
        purpose: 'resized / normalized images',
        transitionToIa: true,
        lambda: 'read',
        ecs: 'rw',
      },
      {
        id: 'Finished',
        key: 'finished',
        purpose: 'print-ready output files',
        lambda: 'read',
        ecs: 'rw',
      },
      {
        id: 'Dzi',
        key: 'dzi',
        purpose: 'Deep Zoom tiles for the proof viewer (CloudFront origin)',
        lambda: 'read',
        ecs: 'rw',
      },
      {
        id: 'Invoices',
        key: 'invoices',
        purpose: 'generated PDF invoices',
        lambda: 'rw',
        ecs: 'read',
      },
    ];

    for (const spec of specs) {
      const lifecycleRules: s3.LifecycleRule[] = [
        // Cost hygiene: never pay for abandoned multipart uploads.
        { abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ];
      if (spec.transitionToIa) {
        lifecycleRules.push({
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(90),
            },
          ],
        });
      }

      const bucket = new s3.Bucket(this, spec.id, {
        // Globally-unique, deterministic name. account is a token at synth time.
        bucketName: `${config.prefix}-${spec.key}-${this.account}`,
        encryption: s3.BucketEncryption.S3_MANAGED, // SSE-S3 (free)
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        // Keep prod data on stack deletion; dev is disposable.
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        autoDeleteObjects: !isProd,
        lifecycleRules,
        cors: spec.cors
          ? [
              {
                allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
                // Tightened to the real web origin once the frontend exists.
                allowedOrigins: ['*'],
                allowedHeaders: ['*'],
                maxAge: 3000,
              },
            ]
          : undefined,
      });

      this.buckets[spec.key] = bucket;

      // --- Least-privilege grants to the compute roles ---
      grant(bucket, lambdaRole, spec.lambda);
      grant(bucket, ecsTaskRole, spec.ecs);

      new cdk.CfnOutput(this, `${spec.id}BucketName`, {
        value: bucket.bucketName,
        description: spec.purpose,
        exportName: `${config.prefix}-${spec.key}-bucket`,
      });
    }
  }
}

function grant(bucket: s3.Bucket, role: iam.IRole | undefined, access: Access): void {
  if (!role) return;
  if (access === 'rw') {
    bucket.grantReadWrite(role);
  } else {
    bucket.grantRead(role);
  }
}
