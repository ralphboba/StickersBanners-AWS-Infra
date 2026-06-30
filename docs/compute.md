# Compute (Week 5)

The compute tiers that finally make the pipeline *run*. Two layers, split by
weight: Lambda for light work, ECS Fargate for heavy image processing.

## 5A — Lambda (`sb-<env>-compute`)

Replaces the Express side of SBBotExpress. Defined in
[`lib/stacks/compute-stack.ts`](../lib/stacks/compute-stack.ts); handler code in
[`src/functions/`](../src/functions).

| Function | Trigger | Does | Grants |
| --- | --- | --- | --- |
| `sb-<env>-poller` | manual now, EventBridge in Week 10 | OrderDesk → clean → enqueue `intake` + record in DynamoDB | intake send, jobs write, SSM read |
| `sb-<env>-notify-consumer` | `notify` SQS messages | send Discord/email | notify consume, SSM read |
| `sb-<env>-order-api` | direct now, API Gateway in Week 6 | read-only order/job status | jobs read |

**Outside the VPC, on purpose.** These functions only call AWS APIs (SQS,
DynamoDB) and the public internet (OrderDesk). Keeping them out of the VPC means
**no NAT Gateway** is required, so the tier is **$0** (free tier: 1M req/month).
VPC-bound functions (e.g. anything needing ElastiCache) would use the IAM
stack's `lambda-exec` role instead.

**Per-function least privilege.** Each Lambda gets its own auto-created role with
exactly the grants in the table — no shared god-role. `notify-consumer` uses an
SQS event source with `reportBatchItemFailures` so only failed messages retry.

The handler files are **skeletons**: the real OrderDesk / Discord logic is filled
in once credentials are seeded into SSM (Week 6).

## 5B — ECS Fargate (`sb-<env>-ecs`)

Replaces SBImageProcessor's Python/FastAPI services. Defined in
[`lib/stacks/ecs-stack.ts`](../lib/stacks/ecs-stack.ts).

| Service | Task size (CPU / MiB) | Does |
| --- | --- | --- |
| `resize` | 1024 / 2048 | PIL resize, ft/in → px @72dpi, TIFF |
| `finish` | 1024 / 2048 | print finishing (grommets / pole pockets / …) |
| `proof` | 512 / 1024 | proof / preview generation |
| `ftp` | 512 / 1024 | FTP transfer to production facilities |

Each service gets: an **ECR repo** (`sb-<env>-<service>`, scan-on-push, keep last
10 images), a **CloudWatch log group** (`/sb/<env>/ecs/<service>`, 1-week
retention), and a **Fargate task definition**.

### No running service = $0 idle

We deliberately create **no `ecs.FargateService`**. Nothing runs (and nothing
costs) until a task is launched on demand. Step Functions will `RunTask` per job
in Week 10, so heavy image processing only costs money while a job is actually
being processed.

### Notes

- Task definitions use the shared IAM **task role** (app permissions:
  S3/SQS/DynamoDB/secrets) but let CDK **auto-create the execution role** per
  task (it receives ECR-pull + log-write grants). Reusing the shared
  `ecs-exec` role here would create a cross-stack dependency cycle.
- Container images don't exist yet, so task defs reference the `latest` tag of
  the (empty) ECR repo as a placeholder until images are built and pushed.

## Deploy

```bash
npx cdk diff   sb-dev-compute sb-dev-ecs --context env=dev
npx cdk deploy sb-dev-compute --context env=dev   # Lambda: $0
npx cdk deploy sb-dev-ecs     --context env=dev   # cluster/ECR/task defs: $0 idle
```

`sb-<env>-ecs` depends on the network VPC; `sb-<env>-compute` depends on the
queues and jobs table. Both depend on `sb-<env>-iam`.
