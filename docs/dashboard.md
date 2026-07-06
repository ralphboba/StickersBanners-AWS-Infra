# Staff Dashboard (`web/index.html`)

A single-file web dashboard where staff sign in, watch orders move through the
pipeline, and approve/reject proofs. No build step, no framework, no external
scripts — one HTML file that talks to the HTTP API.

## What staff can do

1. **Sign in** with their Cognito email/password (accounts are created by an
   admin — self-signup is off).
2. **Browse orders by status** — tabs for `received / processing / manual_hold
   / done / failed` (newest first, via the jobs table's GSI1).
3. **Open an order** — customer, shipping, facility routing, totals, line items
   (size, finishing, quantity).
4. **Review proofs** — when an order needs a proof, an *Approve proof* /
   *Reject* button pair appears (plus optional reject reason). Approve resumes
   the paused Step Functions pipeline; Reject sends it down the failure path.
   A proof-viewer link is shown when the CDN base URL is configured.

## Staff just get a URL

The dashboard is **hosted for you** by the `sb-<env>-webapp` stack: a private
S3 bucket behind CloudFront. Deploy it and hand staff the `DashboardUrl` output
— nothing to install, download, or configure. Staff open the URL and sign in.

```bash
npx cdk deploy sb-dev-webapp --context env=dev
# -> Outputs: sb-dev-webapp.DashboardUrl = https://xxxx.cloudfront.net
```

### No hand-editing of config

`web/index.html` reads its settings from `config.json`, which the webapp stack
**generates at deploy time** from the other stacks' outputs (API URL, Cognito
client id, CDN domain) and uploads next to the page. Redeploy and it stays in
sync; nobody edits the HTML.

## Create staff accounts

Self-signup is disabled, so an admin creates each account once:

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
  --username staff@stickersbanners.com --user-attributes Name=email,Value=staff@stickersbanners.com
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> \
  --username staff@stickersbanners.com --password '<StrongPassw0rd!>' --permanent
```

## How it works (technical)

- **Auth**: Cognito `InitiateAuth` with `USER_PASSWORD_AUTH` via plain `fetch`
  (the app client enables `userPassword` alongside SRP), so no SDK bundle is
  needed. The returned **ID token (JWT)** is sent as `Authorization: Bearer`
  on every API call; the HTTP API's Cognito authorizer verifies it.
- **List**: `GET /orders?status=<s>` — the order-api Lambda queries `GSI1`
  (`GSI1PK = STATUS#<s>`, newest first, limit 100).
- **Detail**: `GET /orders/{name}` — the order's `META` item.
- **Proof review**: `POST /orders/{name}/approve|reject` — resumes/fails the
  paused pipeline via the stored task token (see
  [`api-and-auth.md`](api-and-auth.md#proof-approval-week-8)).
- Tokens expire after 1 hour; the page simply reloads to sign in again on 401.

## Costs

$0 — it's a static file; all backend calls land on the existing free-tier API.
