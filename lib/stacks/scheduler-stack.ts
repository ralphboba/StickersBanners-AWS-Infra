import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { EnvironmentConfig } from '../config/types';

export interface SchedulerStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /** The poller Lambda to invoke on a schedule. */
  readonly pollerFn: lambda.IFunction;
  /** How often the fallback poll runs (default 15 min). */
  readonly intervalMinutes?: number;
}

/**
 * Scheduling (Week 10) — Amazon EventBridge Scheduler.
 *
 * Replaces the legacy BullMQ schedulers. Only the order-poll schedule survives:
 * `mainQueue` (30-min poll) becomes a **fallback** poller (webhook is the
 * primary intake, so this only catches orders a webhook missed). `autoQueue`
 * (10-min auto-routing) is obsolete — routing now happens inline when the
 * webhook cleans each order, so it is intentionally not recreated.
 *
 * Created **DISABLED**: the poller's OrderDesk logic is still a skeleton, so the
 * schedule ships off and is flipped on (console/CLI) once credentials are seeded
 * and the poll logic is filled in. EventBridge Scheduler is free at this volume
 * (14M invocations/mo free) => $0. Uses the `scheduler.amazonaws.com` principal
 * (distinct from the classic EventBridge Rules role), so the L2 construct
 * provisions a dedicated least-privilege execution role scoped to invoking the
 * poller.
 */
export class SchedulerStack extends cdk.Stack {
  public readonly pollerSchedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const { config, pollerFn, intervalMinutes = 15 } = props;

    this.pollerSchedule = new scheduler.Schedule(this, 'PollerFallback', {
      scheduleName: `${config.prefix}-poller`,
      description: 'Primary intake: poll the OrderDesk QTS folder for ready orders',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(intervalMinutes)),
      target: new targets.LambdaInvoke(pollerFn, {
        retryAttempts: 2,
      }),
      // Polling is the primary intake, but it ships OFF: enabling it starts
      // auto-processing REAL QTS orders straight to production (FTP/Drive) and
      // emailing real customers. Flip to ENABLED only as a deliberate go-live.
      enabled: false,
    });

    new cdk.CfnOutput(this, 'PollerScheduleName', {
      value: this.pollerSchedule.scheduleName,
      description: 'DISABLED by default — enable after seeding OrderDesk credentials',
    });
  }
}
