# Secrets & IAM (Week 2)

How StickersBanners credentials are stored, accessed, and locked down on AWS.

## Why Parameter Store (not Secrets Manager)

Credentials live in **SSM Parameter Store SecureString** parameters, which are
**free** (KMS-encrypted with the AWS-managed `aws/ssm` key). Secrets Manager
would cost ~$0.40 per secret per month; its main extra feature is automatic
rotation, which doesn't apply to these third-party credentials (OrderDesk, FTP,
Discord, etc. rotate manually anyway). If a specific secret ever needs auto
rotation, it can be moved to Secrets Manager individually.

## Naming convention

```
/sb/<env>/<group>/<key>
```

Examples: `/sb/dev/orderdesk/api-key`, `/sb/prod/ftp/password`.

The full list of parameters is defined once in
[`lib/config/secrets.ts`](../lib/config/secrets.ts) (`SECRET_PARAMS`).

| Group | Keys |
| --- | --- |
| `orderdesk` | `api-key`, `store-id` |
| `zendesk` | `subdomain`, `email`, `api-token` |
| `ftp` | `host`, `user`, `password` |
| `discord` | `webhook-url` |
| `gmail` | `user`, `app-password` |
| `google` | `service-account-json` (full JSON file contents) |

## Seeding values (the values never touch git)

The repo is **public**, so secret values are never committed. CDK does **not**
create the parameters (CloudFormation can't create SecureString values). Instead:

```bash
# 1. Copy the template and fill in REAL values locally (git-ignored)
cp scripts/parameters.example.env scripts/parameters.dev.env
$EDITOR scripts/parameters.dev.env

# 2. Seed them as encrypted SecureString params
scripts/seed-parameters.sh dev

# 3. Verify
aws ssm get-parameters-by-path --path /sb/dev --recursive --query 'Parameters[].Name'
```

`scripts/parameters.*.env` and `*service_account*.json` are git-ignored.

## IAM roles (least privilege)

Defined in [`lib/stacks/iam-stack.ts`](../lib/stacks/iam-stack.ts) (`sb-<env>-iam`):

| Role | Trusts | Grants |
| --- | --- | --- |
| `sb-<env>-lambda-exec` | `lambda.amazonaws.com` | VPC ENI + logs (managed) + read `/sb/<env>/*` |
| `sb-<env>-ecs-task` | `ecs-tasks.amazonaws.com` | read `/sb/<env>/*` (app code) |
| `sb-<env>-ecs-exec` | `ecs-tasks.amazonaws.com` | image pull + logs (managed) |
| `sb-<env>-eventbridge` | `events.amazonaws.com` | (targets added in Week 10) |

Parameter access is scoped to the env's path
(`arn:aws:ssm:<region>:<account>:parameter/sb/<env>/*`) and `kms:Decrypt` is
restricted via `kms:ViaService = ssm.<region>.amazonaws.com`.

## Reading credentials in code

Both wrappers cache values in-process (5 min TTL) and resolve the env from
`SB_ENV` (default `dev`).

**Node.js (Lambda)** — [`src/shared/secrets.mjs`](../src/shared/secrets.mjs):

```js
import { getSecret, getGroup } from './shared/secrets.mjs';
const apiKey = await getSecret('orderdesk', 'api-key');
const ftp = await getGroup('ftp'); // { host, user, password }
```

The AWS SDK v3 is bundled in the Lambda Node.js runtime, so it is a
`devDependency` only (for local tests).

**Python (ECS Fargate)** — [`src/shared/secrets.py`](../src/shared/secrets.py):

```python
from shared.secrets import get_secret, get_group
api_key = get_secret("orderdesk", "api-key")
ftp = get_group("ftp")  # {"host": ..., "user": ..., "password": ...}
```

## Removing legacy hardcoded credentials

When porting legacy code, replace inline credentials / `process.env` reads with
the wrappers above. The legacy env vars they replace:

| Legacy | Replacement |
| --- | --- |
| `FTP_HOST`, `FTP_USER`, FTP password | `getGroup('ftp')` |
| OrderDesk key/store | `getGroup('orderdesk')` |
| `ZENDESK_SUBDOMAIN` + token | `getGroup('zendesk')` |
| Discord webhook | `getSecret('discord', 'webhook-url')` |
| Gmail app password | `getGroup('gmail')` |
| `service_account.json` | `getSecret('google', 'service-account-json')` |
