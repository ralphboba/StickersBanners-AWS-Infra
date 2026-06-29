# Queues (Week 4B)

SQS queues that replace the legacy BullMQ queues — **not** one-for-one.

## The new approach: right tool for the job

The legacy system had 8 BullMQ queues, but most of them aren't really "queues":

| Legacy BullMQ | What it actually is | AWS home |
| --- | --- | --- |
| `mainQueue` (30 min), `autoQueue` (10 min) | schedulers | **EventBridge Scheduler** (Week 10) |
| `finishQueue`, `proofQueue`, `reviewQueue` | pipeline stages | **Step Functions** (Week 10) |
| `manualQueue` | manual-review hold | Step Functions `waitForTaskToken` |
| `ftpQueue` | retry-prone transfer | **SQS** (here) |
| `emailQueue` | notifications | **SQS** (here) |
| (new) job buffer | decoupling buffer | **SQS** (here) |

Only genuinely durable, retry-prone work stays as SQS. This keeps the system
simpler and far cheaper to change later (schedules/order live in one place
instead of being smeared across produce/consume code in many queues).

## Queues (this stack: `sb-<env>-queues`)

Defined in [`lib/stacks/queue-stack.ts`](../lib/stacks/queue-stack.ts).

| Queue | Carries | Visibility | Lambda | ECS |
| --- | --- | --- | --- | --- |
| `sb-<env>-intake.fifo` | cleaned jobs handed to the pipeline | 300s | send | consume |
| `sb-<env>-ftp.fifo` | outbound FTP transfers to facilities | 300s | — | send + consume |
| `sb-<env>-notify.fifo` | Discord / email notifications | 60s | send + consume | send |

All queues are **FIFO** (ordering + content-based dedup).

## Reliability

- **Dead-letter queue** per queue (`<name>-dlq.fifo`): a message that fails
  `maxReceiveCount = 5` times is quarantined instead of looping forever.
- **Visibility timeout** hides an in-flight message from other consumers while
  one worker processes it; on failure it reappears for automatic retry.
- DLQ retention is 14 days (long enough to inspect failures); work-queue
  retention is 4 days.

## Security & cost

- **SQS-managed SSE** encryption (free — no KMS charge).
- Least-privilege grants: each role gets only `SendMessage` and/or
  `ReceiveMessage`/`DeleteMessage` on the queues it actually uses.
- Free tier covers 1M requests/month → this layer is **$0**.

## Deploy

```bash
npx cdk diff   sb-dev-queues --context env=dev
npx cdk deploy sb-dev-queues --context env=dev
```

Free to deploy (empty queues). Depends on `sb-<env>-iam` for the grants.
