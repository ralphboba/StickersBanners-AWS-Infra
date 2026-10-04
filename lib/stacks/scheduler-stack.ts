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
  /** The demo-feeder Lambda (synthetic orders); enabled schedule if provided. */
  readonly demoFeederFn?: lambda.IFunction;
  /** How often the demo feeder runs (default 15 min). */
  readonly demoIntervalMinutes?: number;
  /**
   * How often the display-only real-order mirror sync runs (default 10 min).
   *
   * Was 5. The mirror now reads 20 OrderDesk folders per run instead of 10
   * (production and Awaiting Shipment were added), and Linh's legacy bot is
   * still polling the same store. Halving the frequency keeps our request rate
   * exactly where it was, so widening the mirror cannot eat into the rate limit
   * the legacy bot depends on. Cost: the staff board is up to 10 minutes stale.
   * The customer-facing money path does not rely on it — it reads OrderDesk
   * directly immediately before charging.
   */
  readonly mirrorIntervalMinutes?: number;
  /** Undo unpaid shipping changes. Ships DISABLED. */
  readonly shippingChangeExpiryFn?: lambda.IFunction;
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
 * The poll schedule is off unless the environment sets `intakePollEnabled`
 * (dev does, since 2026-09-29; prod does not). EventBridge Scheduler is free at this volume
 * (14M invocations/mo free) => $0. Uses the `scheduler.amazonaws.com` principal
 * (distinct from the classic EventBridge Rules role), so the L2 construct
 * provisions a dedicated least-privilege execution role scoped to invoking the
 * poller.
 */
export class SchedulerStack extends cdk.Stack {
  public readonly pollerSchedule: scheduler.Schedule;
  public readonly demoSchedule?: scheduler.Schedule;
  public readonly mirrorSchedule: scheduler.Schedule;
  public readonly expirySchedule?: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const {
      config, pollerFn, intervalMinutes = 15,
      demoFeederFn, demoIntervalMinutes = 15, mirrorIntervalMinutes = 10,
    } = props;

    this.pollerSchedule = new scheduler.Schedule(this, 'PollerFallback', {
      scheduleName: `${config.prefix}-poller`,
      description: 'Primary intake: poll the OrderDesk QTS folder for ready orders',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(intervalMinutes)),
      target: new targets.LambdaInvoke(pollerFn, {
        retryAttempts: 2,
      }),
      // On, this processes REAL QTS orders. Whether they then reach OrderDesk,
      // a customer or a facility is up to the trial switches, not this.
      enabled: config.intakePollEnabled ?? false,
    });

    new cdk.CfnOutput(this, 'PollerScheduleName', {
      value: this.pollerSchedule.scheduleName,
      description: config.intakePollEnabled ? 'ENABLED (intakePollEnabled)' : 'DISABLED (intakePollEnabled unset)',
    });

    // Demo feed — ENABLED. Injects synthetic DEMO-* orders into the real
    // pipeline so the dashboard shows the system working, with no real-world
    // effect (no real OrderDesk read/write, no customer email, no transfer).
    // This is deliberately separate from the (disabled) real poll above.
    if (demoFeederFn) {
      this.demoSchedule = new scheduler.Schedule(this, 'DemoFeed', {
        scheduleName: `${config.prefix}-demo-feed`,
        description: 'Sandbox: feed synthetic DEMO-* orders through the pipeline',
        schedule: scheduler.ScheduleExpression.rate(Duration.minutes(demoIntervalMinutes)),
        target: new targets.LambdaInvoke(demoFeederFn, { retryAttempts: 0 }),
        enabled: true,
      });
      new cdk.CfnOutput(this, 'DemoScheduleName', { value: this.demoSchedule.scheduleName });
    }

    // Mirror sync — ENABLED. DISPLAY-ONLY: shows real QTS orders arriving on the
    // dashboard without ever processing them (poller mirror branch never
    // enqueues). Distinct from the (disabled) real process-poll above.
    this.mirrorSchedule = new scheduler.Schedule(this, 'MirrorSync', {
      scheduleName: `${config.prefix}-mirror-sync`,
      description: 'Display-only: mirror real QTS orders onto the dashboard',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(mirrorIntervalMinutes)),
      target: new targets.LambdaInvoke(pollerFn, {
        retryAttempts: 0,
        input: scheduler.ScheduleTargetInput.fromObject({ mirror: true }),
      }),
      enabled: true,
    });
    new cdk.CfnOutput(this, 'MirrorScheduleName', { value: this.mirrorSchedule.scheduleName });

    // Unpaid shipping changes — DISABLED. It commits Shopify order edits
    // (behind SHOPIFY_WRITES as well); turning it on is part of going live.
    if (props.shippingChangeExpiryFn) {
      this.expirySchedule = new scheduler.Schedule(this, 'ShippingChangeExpiry', {
        scheduleName: `${config.prefix}-shipping-change-expiry`,
        description: 'Undo shipping changes left unpaid past their deadline',
        schedule: scheduler.ScheduleExpression.rate(Duration.hours(1)),
        target: new targets.LambdaInvoke(props.shippingChangeExpiryFn, { retryAttempts: 0 }),
        enabled: false,
      });
    }
  }
}
