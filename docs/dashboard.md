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

## Setup (after deploying the stacks)

Open `web/index.html` and fill in the `CONFIG` block at the top:

| Field | Where to get it |
| --- | --- |
| `apiBase` | `sb-<env>-api` stack output `ApiEndpoint` |
| `userPoolClientId` | `sb-<env>-auth` stack output `UserPoolClientId` |
| `cdnBase` | `sb-<env>-cdn` output `DistributionDomainName` (optional, proof links) |

Create staff accounts (self-signup is disabled):

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
  --username staff@stickersbanners.com --user-attributes Name=email,Value=staff@stickersbanners.com
aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> \
  --username staff@stickersbanners.com --password '<StrongPassw0rd!>' --permanent
```

## Hosting

The file is fully static. Options, simplest first:

1. **Open locally** — double-click the file; it calls the API cross-origin
   (CORS is enabled on the HTTP API).
2. **S3 static hosting / existing CloudFront** — upload `web/index.html` to a
   bucket and serve it; then tighten the API's `corsPreflight.allowOrigins` to
   that origin.

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
