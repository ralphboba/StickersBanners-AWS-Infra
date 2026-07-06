# StickersBanners AWS Infrastructure (CDK)

Infrastructure-as-code for migrating StickersBanners' single-PC order pipeline
(SBBotExpress + SBImageProcessor) to AWS. Written in AWS CDK v2 (TypeScript,
Node 22). Read this file top-to-bottom and you'll understand the whole system.

## Status

- **15 CDK stacks**, **78 unit tests passing**, `cdk synth` clean for `dev` and `prod`.
- **Nothing is deployed yet** — deploys are manual and staged (see [Deploy order](#deploy-order)).
- Steady-state footprint is **$0** under the AWS free tier (the only real cost
  drivers — NAT Gateway, ECS while processing — are off/undeployed).
- Business logic (OrderDesk calls, image code) and secret values are
  intentionally left as skeletons/placeholders — see
  [What still needs filling in](#what-still-needs-filling-in).

## How an order flows end to end

```
OrderDesk ──webhook (push)──▶ API Gateway ──▶ [Lambda: webhook]
   (a customer places an order)                 │ validate shared secret
                                                 │ clean order JSON → job
                                                 │ decide facility (zip → GA/NJ/TX/NV/CA)
                                                 ▼
                              DynamoDB (record) + SQS intake.fifo (enqueue)
                                                 │
                                    [Lambda: pipeline-starter]
                                                 ▼
                              Step Functions state machine (the conductor)
   MarkProcessing → Resize → Finish → NeedsProof?
        yes → Proof → WAIT for human approval  ◀── reviewer hits
        no  ───────────────────────────────┐        POST /orders/{name}/approve|reject
                                            ▼        (Cognito-protected API)
                       Route → SendToTransfer (SQS) → Notify → MarkDone
                              │ FTP (GA/NJ/TX/NV) or Google Drive (CA)
                              └ Discord / email
   any failure → MarkFailed → Notify → Fail

Fallback: EventBridge Scheduler pokes [Lambda: poller] every 15 min to catch
          orders a webhook missed (ships DISABLED).
Proof viewing: CloudFront serves the DZI tiles from the private dzi bucket.
Observability: CloudWatch alarms + dashboard + X-Ray watch the whole path.
```

The design rule throughout: **right tool for the job, least privilege, $0 while
idle, and no secrets in a public repo.**

## Target architecture (legacy → AWS, as built)

| Legacy component | AWS replacement | Stack |
| --- | --- | --- |
| Express routes | Lambda (Node 22) + API Gateway HTTP API | compute, api |
| FastAPI image services | ECS Fargate (resize/finish/proof/ftp) | ecs |
| BullMQ (8 queues) | SQS FIFO + DLQ (intake/ftp/notify) + Step Functions | queues, workflow |
| BullMQ schedulers | EventBridge Scheduler | scheduler |
| Local disk (C:/D:/E:) | S3 (uploads/processed/finished/dzi/invoices) | storage |
| Redis `jobData` | DynamoDB (single-table) | database |
| Redis session / bcrypt auth | Cognito (JWT) | auth |
| Hardcoded credentials | SSM Parameter Store SecureString (**not** Secrets Manager — $0) | iam + `src/shared/secrets` |
| Job orchestration | Step Functions (Standard, with human proof gate) | workflow |
| DZI tile serving | CloudFront (OAC) | cdn |
| Monitoring | CloudWatch alarms/dashboard + X-Ray | observability |

> Redis `cache/session` → an ElastiCache cluster was scoped in the network
> stack but **not built**: `jobData` moved to DynamoDB and sessions to Cognito,
> so a Redis cache wasn't needed. Add it later if a hot cache is required.

## Project layout

```
bin/app.ts              CDK app entry point (env selection + tagging)
lib/config/             Environment configuration (dev / prod)
  types.ts              Config interfaces
  environments.ts       Per-environment values + getConfig()
lib/stacks/
  network-stack.ts      VPC, subnets, NAT/IGW, security groups, VPC endpoints
  storage-stack.ts      S3 buckets (uploads/processed/finished/dzi/invoices)
  database-stack.ts     DynamoDB jobs table (Redis jobData replacement)
  queue-stack.ts        SQS FIFO queues + DLQs (intake/ftp/notify)
  compute-stack.ts      Lambda functions (poller/notify/order-api/webhook)
  ecs-stack.ts          ECS Fargate cluster + ECR + task defs (no running svc)
  auth-stack.ts         Cognito user pool + app client
  api-stack.ts          HTTP API (OrderDesk webhook + Cognito-protected status)
  workflow-stack.ts     Step Functions order pipeline + starter Lambda
  observability-stack.ts CloudWatch alarms + dashboard + SNS ops topic
  scheduler-stack.ts    EventBridge Scheduler fallback poll (ships DISABLED)
  cdn-stack.ts          CloudFront (OAC) in front of the dzi proof tiles
src/functions/          Lambda handler code (Node 22, .mjs)
src/shared/             Shared helpers (secrets, facility routing)
web/index.html          Staff dashboard (single file, no build step)
test/                   Jest unit tests (cdk assertions)
```

## Environments

Select the target environment with CDK context (`dev` is the default):

```bash
npx cdk synth  --context env=dev
npx cdk diff   --context env=prod
npx cdk deploy --context env=prod
```

| Setting | dev | prod |
| --- | --- | --- |
| VPC CIDR | 10.10.0.0/16 | 10.20.0.0/16 |
| AZs | 2 | 2 |
| NAT Gateways | 1 (cost) | 2 (HA) |

## Deploy order

Deploys are manual and staged. CDK resolves dependencies, but the natural order
(and what's safe to skip to stay at $0) is:

1. **Account-level, once:** `sb-github-oidc`, `sb-billing`.
2. **Foundation:** `sb-<env>-iam`, `sb-<env>-cdn` (needed by storage's OAC),
   `sb-<env>-storage`, `sb-<env>-database`, `sb-<env>-queues`, `sb-<env>-auth`.
3. **Compute + wiring:** `sb-<env>-ecs`, `sb-<env>-compute`, `sb-<env>-api`,
   `sb-<env>-workflow`, `sb-<env>-observability`, `sb-<env>-scheduler`.
4. **Skip until needed (cost):** `sb-<env>-network` (NAT Gateway ~$45/mo). ECS
   tasks in private subnets need this (or VPC endpoints for ECR/logs).

```bash
npx cdk synth --context env=dev        # validate everything, no deploy
npx cdk deploy sb-dev-iam --context env=dev   # then proceed stack by stack
```

## Stacks

### Network stack (`sb-<env>-network`)

- VPC across 2 AZs with public + private (egress) subnets.
- Internet Gateway + NAT Gateway(s) for private-subnet outbound traffic.
- Security groups: Lambda, ECS Fargate, ElastiCache Redis, VPC endpoints.
  Redis ingress on 6379 is restricted to the Lambda and ECS SGs.
- VPC endpoints: S3 + DynamoDB (gateway), Secrets Manager + SQS (interface).

### Storage stack (`sb-<env>-storage`)

Replaces the legacy local disk (C:/D:/E:) with five S3 buckets:
`uploads`, `processed`, `finished`, `dzi`, `invoices`. All buckets are
SSE-S3 encrypted, block all public access, enforce TLS, and abort abandoned
multipart uploads after 7 days. The `uploads` bucket has CORS for presigned
browser uploads. dev buckets are destroyed with the stack; prod buckets are
retained. Compute roles get least-privilege access (Lambda owns the API
surface, ECS Fargate does image processing). Empty buckets are **$0** under
the free tier. See [`docs/storage.md`](docs/storage.md).

### Database stack (`sb-<env>-database`)

Replaces the legacy Redis `jobData` store with a single, durable, serverless
DynamoDB table `sb-<env>-jobs`. Single-table design keyed by
`PK=ORDER#<shopify-name>` (e.g. `ORDER#S42166`) / `SK=META|STEP#<stage>`, with
a `GSI1` status-lookup index, `expiresAt` TTL, and on-demand billing (**$0**
while idle). PITR backups on in prod. Compute roles get least-privilege
read/write. See [`docs/database.md`](docs/database.md).

### Queue stack (`sb-<env>-queues`)

Replaces the legacy BullMQ queues — but not one-for-one. Schedulers
(`mainQueue`/`autoQueue`) move to EventBridge and the resize/finish/proof
orchestration moves to Step Functions (later weeks); only genuinely durable,
retry-prone work stays as SQS: `intake`, `ftp`, `notify`. All are FIFO with a
dedicated DLQ (`maxReceiveCount=5`), SQS-managed SSE, and least-privilege
grants. Free tier => **$0**. See [`docs/queues.md`](docs/queues.md).

### Compute stacks (`sb-<env>-compute`, `sb-<env>-ecs`)

The tiers that run the pipeline, split by weight (see
[`docs/compute.md`](docs/compute.md)):

- **Lambda** (`sb-<env>-compute`) — light work: `poller` (OrderDesk → clean →
  enqueue `intake` + record in DynamoDB), `notify-consumer` (drains the notify
  queue), `order-api` (read-only status). Runs **outside the VPC** (no NAT),
  per-function least-privilege roles. Free tier => **$0**.
- **ECS Fargate** (`sb-<env>-ecs`) — heavy image processing (`resize`/`finish`/
  `proof`/`ftp`): cluster + ECR repo + log group + Fargate task definition per
  service, but **no running service**, so idle cost is **$0**. Tasks run on
  demand via the Step Functions workflow.

### API & auth stacks (`sb-<env>-api`, `sb-<env>-auth`)

The HTTP front door (see [`docs/api-and-auth.md`](docs/api-and-auth.md)):

- **HTTP API** (`sb-<env>-api`) with two routes: `POST /webhook/orderdesk`
  (OrderDesk push; the `webhook` Lambda validates a shared secret header) and
  `GET /orders/{name}` (staff status lookup) and `POST /orders/{name}/approve`
  | `/reject` (proof review — resumes the paused pipeline), all protected by a
  Cognito JWT authorizer. OrderDesk now pushes orders instead of being polled.
- **Cognito** (`sb-<env>-auth`): user pool (email sign-in, self-signup off,
  strong password policy) + public app client issuing JWTs.

Both free-tier => **$0** (HTTP API 1M req/month, Cognito 50k MAU). Facility
routing in `src/shared/routing.mjs` is data-driven (zip dictionaries seeded
later, no code change).

### Staff dashboard (`web/index.html`)

How staff actually *use* the system (see [`docs/dashboard.md`](docs/dashboard.md)):
a single-file, no-build web page. Sign in with Cognito → browse orders by
status tab (received/processing/manual_hold/done/failed via `GET /orders`) →
open an order for customer/shipping/routing/items → **Approve / Reject** proofs
(resumes the paused pipeline). Fill in the `CONFIG` block with the deployed
stack outputs; host it anywhere static (or open locally — the API has CORS).

### Workflow stack (`sb-<env>-workflow`)

The order pipeline conductor — a Step Functions **Standard** state machine (see
[`docs/workflow.md`](docs/workflow.md)):

```
MarkProcessing → Resize → Finish → NeedsProof?
   yes → Proof → WaitForApproval (human, waitForTaskToken) ─┐
   no  ─────────────────────────────────────────────────────┤
   → Route? transport → SendToTransfer → Notify → MarkDone
            else      → MarkHeld (manual assignment)
   any failure → MarkFailed → NotifyFailure → Fail
```

ECS steps run on demand (`.sync`), with retries + a catch path. An
`intake.fifo` → `pipeline-starter` Lambda → `StartExecution` trigger drives it.
~$3/month at 9k orders; ECS bills only while processing.

### Observability stack (`sb-<env>-observability`)

The pipeline's eyes (see [`docs/observability.md`](docs/observability.md)):
CloudWatch **alarms** (DLQ depth, Lambda errors, Step Functions failures,
intake backlog) → an SNS **ops topic** (`sb-<env>-ops-alerts`, no subscription
yet — attach email/Discord later), a **dashboard** (`sb-<env>-pipeline`), and
**X-Ray tracing** on the Lambdas + state machine. Within the free tier => **$0**.

### Scheduler stack (`sb-<env>-scheduler`)

EventBridge Scheduler replacing the legacy BullMQ schedulers (see
[`docs/scheduler.md`](docs/scheduler.md)). One `poller-fallback` schedule
(`rate(15 minutes)`, configurable) invokes the `poller` Lambda as a safety net
for webhook-missed orders; the legacy 10-min `autoQueue` is obsolete (routing is
inline now). **Ships DISABLED** — enable after the poller logic + OrderDesk
credentials are ready. Free tier => **$0**.

### CDN stack (`sb-<env>-cdn`)

CloudFront in front of the private `dzi` bucket so the proof viewer loads Deep
Zoom tiles fast (see [`docs/cdn.md`](docs/cdn.md)). Origin Access Control keeps
the bucket private (only this distribution may read); `REDIRECT_TO_HTTPS`,
long-TTL caching, CORS, `PRICE_CLASS_100`. The cross-stack OAC cycle is avoided
by referencing the bucket by deterministic name and attaching the read policy in
the storage stack. CloudFront "Always Free" (1 TB + 10M req/mo) => **$0**.

## Secrets & IAM

Credentials are stored as **free** SSM Parameter Store SecureString parameters
under `/sb/<env>/<group>/<key>`; values are seeded out-of-band and never
committed. IAM roles (`sb-<env>-iam`) grant least-privilege read access. See
[`docs/secrets-and-iam.md`](docs/secrets-and-iam.md). Code wrappers:
`src/shared/secrets.mjs` (Node) and `src/shared/secrets.py` (Python).

## Cost guardrail

`sb-billing` deploys a free monthly AWS Budget that emails the owner the moment
any real charge appears. The steady-state footprint (IAM, OIDC, empty buckets,
SSM standard params) is **$0** under the free tier. The only cost driver is the
NAT Gateway in `sb-<env>-network`, which is intentionally **not deployed** until
needed.

## CI/CD (GitHub Actions + OIDC)

GitHub Actions connects to AWS via OIDC (no long-lived keys). On every push/PR
it runs **build + test + `cdk synth`**; on PRs it runs **`cdk diff`** and posts
the result as a comment. **Deploys are manual** — see the docs.

- One-time setup: [`docs/github-aws-oidc-setup.md`](docs/github-aws-oidc-setup.md)
- OIDC trust stack: `sb-github-oidc` (deployed once per account)
- Workflow: `.github/workflows/ci.yml`

## What still needs filling in

The infrastructure is complete; these are the values/code and go-live steps left
(all deliberately deferred so the repo could stay public and $0):

- [ ] **Seed credentials** into SSM (git-ignored `scripts/parameters.dev.env` →
  `scripts/seed-parameters.sh dev`): OrderDesk api-key/store-id/**webhook-secret**,
  FTP, Discord, Gmail, Google service account.
- [ ] **Seed the zip routing dictionaries** (NV/CA) used by
  `src/shared/routing.mjs`; define the GA/NJ/TX rule.
- [ ] **Fill the OrderDesk call logic** in `src/functions/poller` and
  `src/functions/webhook` (field paths are best-effort until verified live).
- [ ] **Build + push the ECS container images** (resize/finish/proof/ftp) to the
  ECR repos; replace the placeholder `latest` tag.
- [ ] **Enable the scheduler** (`sb-<env>-poller-fallback` ships DISABLED) once
  the poller logic is ready.
- [ ] **Subscribe a destination** (email/Discord) to the `sb-<env>-ops-alerts`
  SNS topic.
- [ ] **Dashboard**: fill `web/index.html`'s `CONFIG` with the deployed API /
  Cognito / CDN outputs, and create staff accounts (`admin-create-user`).
- [ ] Set the GitHub Actions **`AWS_ROLE_ARN`** variable to enable `cdk diff` on PRs.
- [ ] **Rotate/delete** any AWS access key that was ever pasted into a chat.
- [ ] For real ECS runs in private subnets: deploy `sb-<env>-network` **or** add
  ECR/logs VPC endpoints.

## Common commands

```bash
npm install        # install dependencies
npm run build      # tsc compile
npm test           # jest unit tests
npx cdk synth --context env=dev   # synthesize CloudFormation (no deploy)
npx cdk ls   --context env=dev    # list stacks
npx cdk diff --context env=dev    # diff against deployed stack
```

## Prerequisites

- Node.js 22+
- AWS CDK 2.x (`npx cdk`)
- AWS CLI v2 (configure credentials with `aws configure` before deploy)
- Docker (for later ECS/Lambda asset bundling)

> Bootstrap the account/region once before the first deploy:
> `npx cdk bootstrap --context env=dev`
