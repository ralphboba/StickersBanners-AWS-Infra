# Database (Week 4A)

DynamoDB table that replaces the legacy Redis `jobData` store.

## Why DynamoDB (not Redis)

Redis lived in the single PC's RAM, so an in-progress order's state vanished on
a crash and there were no backups. DynamoDB is a fully-managed, serverless
NoSQL database: data persists to disk, is auto-backed-up, and scales with no
servers to run. On-demand billing means it costs **$0** while idle (free tier:
25 GB storage + a generous on-demand request allowance).

## Table: `sb-<env>-jobs`

Defined in [`lib/stacks/database-stack.ts`](../lib/stacks/database-stack.ts)
(`sb-<env>-database`). Single-table design — orders and their per-stage
processing state live together.

| Setting | Value |
| --- | --- |
| Partition key | `PK` (string) |
| Sort key | `SK` (string) |
| Billing | On-demand (`PAY_PER_REQUEST`) — $0 while idle |
| Encryption | AWS-owned key (default, free) |
| TTL | `expiresAt` (epoch seconds) — auto-deletes old completed orders |
| PITR (35-day backups) | prod = on, dev = off |
| Removal | dev = `DESTROY`, prod = `RETAIN` |

### Key design

```
PK = ORDER#<shopify-name>     e.g. ORDER#S42166   (Shopify order names keep the "S")
SK = META                     order summary (one per order)
SK = STEP#<stage>             per-stage processing state (resize/finish/proof/...)
```

Example items:

```
PK=ORDER#S42166  SK=META          { status:"processing", customer:"Blaine McKinney",
                                    total:481.40, items:15, createdAt:"2026-06-29T15:43Z",
                                    GSI1PK:"STATUS#processing", GSI1SK:"2026-06-29T15:43Z" }
PK=ORDER#S42166  SK=STEP#resize   { state:"done",    finishedAt:... }
PK=ORDER#S42166  SK=STEP#finish   { state:"pending" }
```

### GSI1 — status lookup

Answers *"show me every order currently in `<status>`"* (e.g. for a dashboard):

| | Attribute |
| --- | --- |
| `GSI1PK` | `STATUS#<status>` (e.g. `STATUS#processing`) |
| `GSI1SK` | `createdAt` (ISO) — newest/oldest ordering |

Projection is `ALL` so queries return the full item without a second read.

## IAM

Both compute tiers get `grantReadWriteData` (covers the table **and** GSI1):

- **Lambda** — writes the order on intake (API), reads for status checks.
- **ECS Fargate** — updates each `STEP#` row as it advances the pipeline.

## Reading/writing in code

PK/SK are app-level conventions. A later shared helper will wrap
`PutItem`/`Query`; for now the contract is the key design above.

## Deploy

```bash
npx cdk diff   sb-dev-database --context env=dev
npx cdk deploy sb-dev-database --context env=dev
```

Free to deploy (on-demand, empty). Depends on `sb-<env>-iam` for the grants.
