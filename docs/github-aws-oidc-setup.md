# GitHub ↔ AWS connection (OIDC) — one-time setup

This connects GitHub Actions to your AWS account **without storing long-lived
access keys**. GitHub Actions assumes an IAM role via OpenID Connect (OIDC) and
receives short-lived (≈1 hour) credentials.

Automation scope: CI runs **build + test + `cdk diff`** only. Deploys stay
**manual** — see "Deploying manually" at the bottom.

---

## Why this is safe

- No AWS password/access key is ever stored in GitHub.
- The IAM role trusts **only** `repo:ralphboba/StickersBanners-AWS-Infra:*`.
- Each CI run gets a fresh credential that expires within an hour.

---

## One-time bootstrap (run from your own machine)

You need AWS credentials configured locally **once** to create the trust. After
this, GitHub does everything itself.

### 1. Configure AWS CLI (if not already)

```bash
aws configure          # paste your AWS access key, secret, region (us-east-1)
aws sts get-caller-identity   # verify it works
```

### 2. Bootstrap the CDK environment (first time per account/region)

```bash
npx cdk bootstrap --context env=dev
```

### 3. Deploy the OIDC trust stack

```bash
# If your account has NEVER set up a GitHub OIDC provider:
npx cdk deploy sb-github-oidc

# If a GitHub OIDC provider ALREADY exists in the account, import it instead:
npx cdk deploy sb-github-oidc --context useExistingProvider=true
```

> Not sure if one exists? Check:
> ```bash
> aws iam list-open-id-connect-providers
> ```
> If you see an ARN ending in `token.actions.githubusercontent.com`, use
> `--context useExistingProvider=true`.

### 4. Copy the role ARN from the output

The deploy prints:

```
sb-github-oidc.GithubActionsRoleArn = arn:aws:iam::<account>:role/sb-github-actions-cdk
```

### 5. Add it to GitHub as a repository variable

Repo → **Settings → Secrets and variables → Actions → Variables → New variable**

| Name | Value |
| --- | --- |
| `AWS_ROLE_ARN` | the ARN from step 4 |

That's it. The `cdk diff` job in CI activates automatically once `AWS_ROLE_ARN`
is set. Until then, CI still runs build + test + synth (which need no AWS access).

---

## What CI does

| Trigger | Job | AWS access? |
| --- | --- | --- |
| any push / PR | build, test, `cdk synth` | no |
| pull request | `cdk diff` → posted as PR comment | yes (read, via OIDC) |
| — | **deploy** | **manual only** |

The diff comment shows exactly what would change in AWS before you approve.

---

## Deploying manually

Deploys are intentionally **not** automated. From your machine:

```bash
npx cdk diff   --context env=dev      # review changes
npx cdk deploy --context env=dev      # apply (dev)

npx cdk deploy --context env=prod     # apply (prod)
```
