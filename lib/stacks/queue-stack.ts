import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { EnvironmentConfig } from '../config/types';

export interface QueueStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /**
   * Compute roles (from the IAM stack) granted least-privilege queue access.
   * Optional so the stack still synthesizes/tests standalone.
   */
  readonly lambdaRole?: iam.IRole;
  readonly ecsTaskRole?: iam.IRole;
}

/** Who may send to / consume from a queue. */
type RoleAccess = 'send' | 'consume' | 'both' | 'none';

interface QueueSpec {
  /** Construct id. */
  readonly id: string;
  /** Logical name; becomes `<prefix>-<key>.fifo`. */
  readonly key: string;
  /** What it carries. */
  readonly purpose: string;
  /** Seconds a consumer has to process before the message reappears. */
  readonly visibilityTimeoutSec: number;
  /** Lambda (API/poller) access. */
  readonly lambda: RoleAccess;
  /** ECS Fargate (workers) access. */
  readonly ecs: RoleAccess;
}

/** Times a message can be received before it lands in the DLQ. */
const MAX_RECEIVE_COUNT = 5;

/**
 * SQS layer (Week 4B).
 *
 * Replaces the legacy BullMQ queues — but deliberately *not* one-for-one.
 * Schedulers (mainQueue/autoQueue) become EventBridge Scheduler and the
 * resize/finish/proof/review orchestration becomes Step Functions (both later
 * weeks). Only the work that is genuinely a durable, retry-prone queue lives
 * here:
 *
 *   intake  — cleaned jobs handed from the poller to the processing pipeline
 *   ftp     — outbound transfers to production facilities (retry-heavy)
 *   notify  — Discord / email notifications
 *
 * All queues are FIFO (ordering + dedup) with a dedicated DLQ (messages that
 * fail MAX_RECEIVE_COUNT times are quarantined). SQS-managed SSE is free and
 * the free tier covers 1M requests/month, so this layer is **$0**.
 */
export class QueueStack extends cdk.Stack {
  public readonly queues: Record<string, sqs.Queue> = {};
  public readonly deadLetterQueues: Record<string, sqs.Queue> = {};

  constructor(scope: Construct, id: string, props: QueueStackProps) {
    super(scope, id, props);

    const { config, lambdaRole, ecsTaskRole } = props;

    const specs: QueueSpec[] = [
      {
        id: 'Intake',
        key: 'intake',
        purpose: 'cleaned jobs handed to the processing pipeline',
        visibilityTimeoutSec: 300,
        lambda: 'send', // poller enqueues
        ecs: 'consume', // workers dequeue
      },
      {
        id: 'Ftp',
        key: 'ftp',
        purpose: 'outbound FTP transfers to production facilities',
        visibilityTimeoutSec: 300,
        lambda: 'none',
        ecs: 'both', // a worker enqueues, the ftp worker consumes
      },
      {
        id: 'Notify',
        key: 'notify',
        purpose: 'Discord / email notifications',
        visibilityTimeoutSec: 60,
        lambda: 'both', // anyone notifies; a consumer drains it
        ecs: 'send',
      },
    ];

    for (const spec of specs) {
      // Dead-letter queue (also FIFO, required for a FIFO source).
      const dlq = new sqs.Queue(this, `${spec.id}Dlq`, {
        queueName: `${config.prefix}-${spec.key}-dlq.fifo`,
        fifo: true,
        contentBasedDeduplication: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED, // free SSE
        retentionPeriod: Duration.days(14), // keep failures long enough to inspect
      });

      const queue = new sqs.Queue(this, spec.id, {
        queueName: `${config.prefix}-${spec.key}.fifo`,
        fifo: true,
        contentBasedDeduplication: true,
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        visibilityTimeout: Duration.seconds(spec.visibilityTimeoutSec),
        retentionPeriod: Duration.days(4),
        deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEIVE_COUNT },
      });

      this.deadLetterQueues[spec.key] = dlq;
      this.queues[spec.key] = queue;

      // --- Least-privilege grants ---
      grant(queue, lambdaRole, spec.lambda);
      grant(queue, ecsTaskRole, spec.ecs);

      new cdk.CfnOutput(this, `${spec.id}QueueUrl`, {
        value: queue.queueUrl,
        description: spec.purpose,
        exportName: `${config.prefix}-${spec.key}-queue-url`,
      });
      new cdk.CfnOutput(this, `${spec.id}QueueArn`, {
        value: queue.queueArn,
        exportName: `${config.prefix}-${spec.key}-queue-arn`,
      });
    }
  }
}

function grant(queue: sqs.Queue, role: iam.IRole | undefined, access: RoleAccess): void {
  if (!role || access === 'none') return;
  if (access === 'send' || access === 'both') queue.grantSendMessages(role);
  if (access === 'consume' || access === 'both') queue.grantConsumeMessages(role);
}
