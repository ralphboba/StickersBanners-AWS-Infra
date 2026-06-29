# StickersBanners AWS Infrastructure (CDK)

Infrastructure-as-code for migrating StickersBanners' single-PC order pipeline
(SBBotExpress + SBImageProcessor) to AWS. Written in AWS CDK (TypeScript).

## Target architecture

| Legacy component | AWS replacement |
| --- | --- |
| Express routes | Lambda (Node.js 22) + API Gateway |
| FastAPI image services | ECS Fargate (resize / finish / proof / ftp) |
| BullMQ (8 queues) | SQS FIFO + DLQ |
| Local disk (C:/D:/E:) | S3 (uploads/processed/finished/dzi/invoices) |
| Redis jobData | DynamoDB |
| Redis cache/session | ElastiCache Redis + Cognito |
| Hardcoded credentials | Secrets Manager |
| BullMQ schedulers | EventBridge |
| Job orchestration | Step Functions |
| DZI tile serving | CloudFront |

## Project layout

```
bin/app.ts              CDK app entry point (env selection + tagging)
lib/config/             Environment configuration (dev / prod)
  types.ts              Config interfaces
  environments.ts       Per-environment values + getConfig()
lib/stacks/
  network-stack.ts      VPC, subnets, NAT/IGW, security groups, VPC endpoints
  storage-stack.ts      S3 buckets (uploads/processed/finished/dzi/invoices)
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

## Common commands

```bash
npm install        # install dependencies
npm run build      # tsc compile
npm test           # jest unit tests
npx cdk synth      # synthesize CloudFormation
npx cdk diff       # diff against deployed stack
```

## Prerequisites

- Node.js 22+
- AWS CDK 2.x (`npx cdk`)
- AWS CLI v2 (configure credentials with `aws configure` before deploy)
- Docker (for later ECS/Lambda asset bundling)

> Bootstrap the account/region once before the first deploy:
> `npx cdk bootstrap --context env=dev`
