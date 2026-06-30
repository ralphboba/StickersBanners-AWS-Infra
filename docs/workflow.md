# Workflow (Week 7)

The order pipeline orchestration — an AWS **Step Functions (Standard)** state
machine that finally wires every piece into one flow.

## Why Step Functions Standard

The pieces existed (queues, ECS task defs, DynamoDB, S3, notifications) but
nothing sequenced them. Step Functions is the conductor: it owns the order of
steps, retries, branching, and — crucially — the **long human approval wait**
for proofs (`waitForTaskToken`), which the queue/Lambda alternatives handle
poorly.

At ~9,000 orders/month it costs roughly **$3/month** (Standard: $0.025 per
1,000 state transitions, first 4,000 free). The real compute cost is ECS
Fargate, billed only while a task runs.

## The state machine (`sb-<env>-pipeline`)

```
MarkProcessing            DynamoDB status=processing (+ GSI1 status key)
   │
Resize                    ECS RunTask(resize)  .sync, retry x3
   │
Finish                    ECS RunTask(finish)  .sync, retry x3
   │
NeedsProof? ──yes──▶ Proof (ECS) ──▶ WaitForApproval ──┐
   │                                  (waitForTaskToken) │
   └──no───────────────────────────────────────────────┤
                                                         ▼
RouteChoice ── transport present ─▶ SendToTransfer ─▶ Notify ─▶ MarkDone
            └─ else (UNROUTED) ───▶ MarkHeld   (held for manual assignment)

Any failure ─▶ MarkFailed ─▶ NotifyFailure ─▶ Fail
```

- **ECS steps** use the `.sync` (RUN_JOB) pattern — the workflow launches a
  Fargate task on demand and waits for it to finish. The cleaned job is passed
  to the container via `ORDER_NAME` and a JSON `JOB` env var. Each has 3 retries
  with backoff and a catch to the failure path.
- **WaitForApproval** invokes the `request-approval` Lambda with the task token
  (`lambda:invoke.waitForTaskToken`); the Lambda stores the token on the order
  (`SK=APPROVAL`, status `pending`) and the workflow pauses. The reviewer is
  pinged separately via `NotifyProofReady`. The approval API (Week 8) resumes it
  — see [`docs/api-and-auth.md`](api-and-auth.md#proof-approval-week-8).
- **RouteChoice** only ships when a facility/transport was resolved; otherwise
  the order is parked in `manual_hold` rather than sent to the wrong place
  (recall facility routing is data-driven and the zip dictionaries are seeded
  later).
- **SendToTransfer** enqueues the job on `ftp.fifo`; the outbound worker
  dispatches FTP vs Google Drive by the job's `routing.transport` field.

## Trigger: intake → starter → execution

```
intake.fifo ──▶ [Lambda: pipeline-starter] ──StartExecution──▶ state machine
```

A tiny `pipeline-starter` Lambda (SQS event source, partial-batch retry) starts
one execution per cleaned job. EventBridge Pipes is the no-code alternative; a
Lambda is used here for reliable JSON-body handling. See
[`src/functions/pipeline-starter`](../src/functions/pipeline-starter).

## Permissions

The state-machine role is granted (by CDK, least-privilege): `ecs:RunTask` +
`iam:PassRole` for the task/execution roles, `dynamodb:UpdateItem` on the jobs
table, and `sqs:SendMessage` on the transfer/notify queues. The starter role
gets `states:StartExecution`.

## Not in this stack (intentional)

- The **approval API** (token → `SendTaskSuccess`) — Week 8.
- Real **container images** — still placeholders, so this stays $0-idle.
- Deploying tasks into private subnets will need ECR/logs VPC endpoints (or
  NAT); out of scope while undeployed.

## Deploy

```bash
npx cdk diff   sb-dev-workflow --context env=dev
npx cdk deploy sb-dev-workflow --context env=dev
```

Depends on the ECS cluster/task defs, network VPC, jobs table, and the
intake/ftp/notify queues.
