# Observability (Week 9)

The "eyes" for the pipeline: alerting, a dashboard, and request tracing. Until
now failures were silent — DLQ depth, Lambda errors, and Step Functions
failures had no alarms.

## Alerts (`sb-<env>-observability`)

Defined in [`lib/stacks/observability-stack.ts`](../lib/stacks/observability-stack.ts).

### SNS topic — `sb-<env>-ops-alerts`

All alarms notify this topic. It intentionally has **no subscription yet** —
the alert destination wasn't decided. Attach one later and alerts flow
immediately, e.g.:

```bash
# email
aws sns subscribe --topic-arn <sb-<env>-ops-alerts-arn> \
  --protocol email --notification-endpoint you@stickersbanners.com
# (Discord: subscribe a small Lambda that reposts to the Discord webhook)
```

Kept separate from BillingStack's Budgets email (that's cost, this is ops).

### Alarms (8 — within the 10 free)

| Alarm | Fires when |
| --- | --- |
| `dlq-intake-not-empty` / `dlq-ftp-not-empty` / `dlq-notify-not-empty` | any message lands in a dead-letter queue |
| `lambda-webhook-errors` / `lambda-poller-errors` / `lambda-approval-errors` | the function throws (Errors > 0 / 5 min) |
| `pipeline-failed` | a Step Functions execution fails |
| `intake-backlog` | oldest intake message older than 15 min (stuck consumer) |

Built with the L2 metric helpers (`metricApproximateNumberOfMessagesVisible`,
`metricErrors`, `metricFailed`, `metricApproximateAgeOfOldestMessage`);
`treatMissingData: NOT_BREACHING` so quiet periods don't false-alarm.

### Dashboard — `sb-<env>-pipeline`

Three widgets: pipeline executions (started/succeeded/failed), Lambda
invocations vs errors, and queue depths (intake + DLQs).

## Tracing (X-Ray)

- **Lambda**: `tracing: ACTIVE` on every function (compute stack `base` props);
  CDK adds the X-Ray write permissions automatically.
- **Step Functions**: `tracingEnabled: true` plus ERROR-level execution logging
  to `/sb/<env>/states/pipeline` (1-week retention). This lets you follow a
  single order across webhook → SQS → pipeline → ECS and spot the slow/failing
  step.

## Cost

- CloudWatch: 8 alarms (≤10 free) + 1 dashboard (≤3 free) → **$0**.
- X-Ray: within the 100k-traces/month free tier at ~9k orders.
- SNS: free (no subscription yet; 1k email notifications/month free once added).
- Step Functions ERROR logging: a few cents at most.

## Deploy

```bash
npx cdk deploy sb-dev-observability --context env=dev
```

Depends on the queues, the critical Lambdas, and the state machine. After
deploy, subscribe a destination to the ops-alerts topic (see above).
