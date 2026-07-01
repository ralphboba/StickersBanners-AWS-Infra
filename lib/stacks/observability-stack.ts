import * as cdk from 'aws-cdk-lib/core';
import { Duration } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { EnvironmentConfig } from '../config/types';

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  /** Dead-letter queues to watch for stuck/failed messages. */
  readonly deadLetterQueues: Record<string, sqs.IQueue>;
  /** Intake queue — watched for backlog (age of oldest message). */
  readonly intakeQueue: sqs.IQueue;
  /** Critical Lambdas to alarm on errors. */
  readonly lambdas: Record<string, lambda.IFunction>;
  /** The pipeline state machine. */
  readonly stateMachine: sfn.IStateMachine;
}

/**
 * Observability (Week 9).
 *
 * The "eyes" for the pipeline: alarms, a dashboard, and (via edits to the
 * compute/workflow stacks) X-Ray tracing. Until now failures were silent —
 * DLQ depth, Lambda errors, and Step Functions failures had no alerting.
 *
 * Alarms notify an SNS topic that intentionally has **no subscription yet**;
 * the owner attaches email/Discord/Lambda to `sb-<env>-ops-alerts` later and
 * alerts start flowing immediately. Kept within the free tier (<= 10 alarms,
 * <= 3 dashboards) => $0.
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { config, deadLetterQueues, intakeQueue, lambdas, stateMachine } = props;

    // Alerts fan-out point. No subscription on purpose — attach one later.
    this.alertTopic = new sns.Topic(this, 'OpsAlerts', {
      topicName: `${config.prefix}-ops-alerts`,
      displayName: `StickersBanners ops alerts (${config.env})`,
    });
    const action = new cwactions.SnsAction(this.alertTopic);

    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, desc: string): void => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: `${config.prefix}-${id}`,
        alarmDescription: desc,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(action);
    };

    const p5 = { period: Duration.minutes(5) };

    // --- DLQ depth: any message in a dead-letter queue is a problem ---
    for (const [key, dlq] of Object.entries(deadLetterQueues)) {
      alarm(
        `dlq-${key}-not-empty`,
        dlq.metricApproximateNumberOfMessagesVisible({ ...p5, statistic: 'Maximum' }),
        0,
        `${key} dead-letter queue has messages`,
      );
    }

    // --- Lambda errors on the critical functions ---
    for (const [key, fn] of Object.entries(lambdas)) {
      alarm(
        `lambda-${key}-errors`,
        fn.metricErrors({ ...p5, statistic: 'Sum' }),
        0,
        `${key} Lambda is throwing errors`,
      );
    }

    // --- Step Functions execution failures ---
    alarm(
      'pipeline-failed',
      stateMachine.metricFailed({ ...p5, statistic: 'Sum' }),
      0,
      'Order pipeline executions are failing',
    );

    // --- Intake backlog: oldest message waiting too long (> 15 min) ---
    alarm(
      'intake-backlog',
      intakeQueue.metricApproximateAgeOfOldestMessage({ ...p5, statistic: 'Maximum' }),
      900,
      'Intake queue backlog: oldest message older than 15 minutes',
    );

    // --- Dashboard ---
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${config.prefix}-pipeline`,
    });
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pipeline executions',
        left: [
          stateMachine.metricStarted({ ...p5, statistic: 'Sum' }),
          stateMachine.metricSucceeded({ ...p5, statistic: 'Sum' }),
          stateMachine.metricFailed({ ...p5, statistic: 'Sum' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda invocations / errors',
        left: Object.values(lambdas).map((fn) => fn.metricInvocations({ ...p5, statistic: 'Sum' })),
        right: Object.values(lambdas).map((fn) => fn.metricErrors({ ...p5, statistic: 'Sum' })),
      }),
      new cloudwatch.GraphWidget({
        title: 'Queue depth',
        left: [
          intakeQueue.metricApproximateNumberOfMessagesVisible({ ...p5, statistic: 'Maximum' }),
          ...Object.values(deadLetterQueues).map((q) =>
            q.metricApproximateNumberOfMessagesVisible({ ...p5, statistic: 'Maximum' }),
          ),
        ],
      }),
    );

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'Subscribe email/Discord/Lambda here to receive ops alerts',
      exportName: `${config.prefix}-ops-alerts-arn`,
    });
  }
}
