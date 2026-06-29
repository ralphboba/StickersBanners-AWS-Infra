# StickersBanners AWS Migration — Week 1–4 Technical Summary

**Period:** Week 1–4 · **Branch:** `claude/stickerbanners-aws-cdk-fw49s2`
**Stack:** AWS CDK v2 (TypeScript), Node 22 · **Tests:** 36 passing · **Deployed cost:** $0

Goal: migrate the single-Windows-PC order pipeline (SBBotExpress + SBImageProcessor)
to AWS, infrastructure-as-code, under a strict **$0 free-tier** budget on a
**public** repo (no secret values ever committed). Code is authored and tested
here; **deploys are manual** (`cdk deploy`), nothing is auto-deployed.

---

## Week 1 — Foundation, CI/CD, cost guardrail

| Stack | What it does | Deployed? |
| --- | --- | --- |
| CDK project | Multi-env app (`--context env=dev\|prod`), typed config, Jest | n/a |
| `sb-<env>-network` | VPC (2 AZ, public+private), NAT, 4 SGs, VPC endpoints (S3/DynamoDB gateway; Secrets Mgr/SQS interface) | **No** (NAT ~$45/mo) |
| `sb-github-oidc` | GitHub Actions OIDC trust → role scoped to this repo, may assume `cdk-*` only | **Yes** (free) |
| `sb-billing` | AWS Budget $5/mo, email alerts at first real charge | **Yes** (free) |
| CI (`ci.yml`) | build + test + `cdk synth` on push; `cdk diff` comment on PRs; deploys manual | n/a |

**Key decisions:** OIDC instead of stored AWS keys (public repo = no leak risk);
network defined but **not deployed** (only real cost driver); first-2-budgets-free.

## Week 2 — Secrets & least-privilege IAM

- **SSM Parameter Store SecureString** (free, KMS `aws/ssm`) for all credentials
  instead of Secrets Manager (~$0.40/secret/mo). Path: `/sb/<env>/<group>/<key>`.
- Values **seeded out-of-band** (`scripts/seed-parameters.sh` from git-ignored
  `.env`); CloudFormation never holds secret values. Names live in
  `lib/config/secrets.ts`.
- `sb-<env>-iam`: 4 roles (lambda-exec, ecs-task, ecs-exec, eventbridge). SSM read
  scoped to `parameter/sb/<env>/*`; `kms:Decrypt` restricted via
  `kms:ViaService = ssm.<region>.amazonaws.com`.
- Code wrappers `src/shared/secrets.mjs` / `.py` (5-min TTL cache).

**Deployed:** IAM (free). **Decision:** Parameter Store over Secrets Manager for $0.

## Week 3 — S3 storage layer

`sb-<env>-storage`: 5 buckets replacing local disk (C:/D:/E:):
`uploads`, `processed`, `finished`, `dzi`, `invoices`.

- Every bucket: **SSE-S3** (free), block-all-public-access, **enforce TLS**
  (deny non-HTTPS), abort incomplete multipart uploads after 7 days.
- `uploads` has CORS (presigned browser PUT); `uploads`/`processed` → Infrequent
  Access after 90 days.
- dev = `DESTROY`+autoDelete, prod = `RETAIN`.
- Least-privilege grants: Lambda owns the API surface (uploads/invoices RW),
  ECS does image processing (processed/finished/dzi RW).

**Cost:** $0 empty (free tier 5 GB / 20k GET / 2k PUT). **Not deployed.**

## Week 4A — DynamoDB job state

`sb-<env>-database` → table `sb-<env>-jobs` replacing Redis `jobData` (RAM-only,
lost on crash) with a durable serverless store.

- Single-table design: `PK = ORDER#<shopify-name>` (e.g. `ORDER#S42166`),
  `SK = META | STEP#<stage>`.
- `GSI1` (`GSI1PK=STATUS#<status>`, `GSI1SK=createdAt`) for status dashboards.
- On-demand billing ($0 idle), `expiresAt` TTL, AWS-owned-key encryption,
  PITR backups on in prod, dev=`DESTROY`/prod=`RETAIN`.
- `grantReadWriteData` to Lambda + ECS (covers GSI).

## Week 4B — SQS queues (new approach, not 1:1 BullMQ)

`sb-<env>-queues`. The legacy 8 BullMQ queues are split by **right tool for the job**:

| Legacy | New home |
| --- | --- |
| `mainQueue`/`autoQueue` (schedulers) | EventBridge Scheduler (Week 10) |
| `finish`/`proof`/`review` (stages) | Step Functions (Week 10) |
| `manualQueue` | Step Functions `waitForTaskToken` |
| `ftp`, `email`, + job buffer | **SQS** (this stack) |

Built now: `intake.fifo`, `ftp.fifo`, `notify.fifo` — all FIFO + content dedup,
each with a dedicated **DLQ** (`maxReceiveCount=5`), SQS-managed SSE, and
least-privilege send/consume grants.

**Cost:** $0 (free tier 1M req/mo). **Rationale:** mirroring 8 queues makes
later schedule/order changes expensive; this keeps changes to a single place.

---

## Cross-cutting principles

- **$0 always:** every deployed resource is free-tier; the only cost drivers
  (NAT, storage bytes, PITR-in-dev) are off or undeployed.
- **Public repo safe:** no secret values in git; OIDC, not stored keys.
- **Least privilege:** every grant scoped to the exact resource/path/action.
- **Multi-env:** identical constructs, env-appropriate sizing & removal policy.
- **Manual deploys:** CI validates (build/test/synth/diff); humans deploy.
- **Design for change:** data-driven routing (zip dictionaries → DynamoDB),
  orchestration in one place (Step Functions) — cheap to modify later.

## Architecture mapping (legacy → AWS)

| Legacy | AWS | Week |
| --- | --- | --- |
| Local disk C:/D:/E: | S3 (5 buckets) | 3 |
| Redis `jobData` | DynamoDB `sb-<env>-jobs` | 4A |
| BullMQ queues | SQS FIFO + DLQ / EventBridge / Step Functions | 4B / 10 |
| Hardcoded credentials | SSM Parameter Store + IAM roles | 2 |
| Network/VPC | VPC + SGs + endpoints (defined, not deployed) | 1 |
| Manual key handling | GitHub OIDC + CI | 1 |

## Status snapshot

- **Deployed (free):** GitHub OIDC, Billing budget, IAM roles.
- **Coded, not deployed:** Network, S3, DynamoDB, SQS (all $0 to deploy).
- **Pending:** zip routing dictionaries (need OrderDesk rule values), OrderDesk
  API credential seeding, rotate leaked access key `AKIA…KHPR`.
- **Next:** Week 5 — ElastiCache Redis + Cognito, or Lambda (Express routes).
