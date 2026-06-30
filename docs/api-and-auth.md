# API & Auth (Week 6)

The HTTP front door and authentication. OrderDesk now **pushes** orders via a
webhook (replacing the poll loop), and staff read order status through a
Cognito-protected API.

## Acronyms

| Acronym | Stands for | Meaning |
| --- | --- | --- |
| API | Application Programming Interface | the contract programs call each other over |
| HTTP | HyperText Transfer Protocol | the web's request/response protocol |
| REST | REpresentational State Transfer | a classic API style; AWS offers "REST API" and a cheaper "HTTP API" |
| MAU | Monthly Active Users | distinct users active in a month (Cognito's pricing unit) |
| JWT | JSON Web Token | a signed, verifiable login token presented on each request |
| JSON | JavaScript Object Notation | the `{ "key": "value" }` text data format |

## Routes (`sb-<env>-api`, HTTP API)

| Route | Caller | Auth | Lambda |
| --- | --- | --- | --- |
| `POST /webhook/orderdesk` | OrderDesk | **shared secret header** (checked in the Lambda) | `webhook` |
| `GET /orders/{name}` | staff / web | **Cognito JWT** authorizer | `order-api` |
| `POST /orders/{name}/approve` | reviewer | **Cognito JWT** authorizer | `approval` |
| `POST /orders/{name}/reject` | reviewer | **Cognito JWT** authorizer | `approval` |

Why the split: OrderDesk is a third-party server and can't hold a Cognito JWT,
so its route is unauthenticated *at the gateway* and the `webhook` Lambda
verifies a shared secret itself. The staff route uses a proper JWT authorizer.

HTTP API (not REST API) — cheaper, and free up to 1M requests/month => **$0**.

## Webhook flow

```
OrderDesk ──POST /webhook/orderdesk (x-orderdesk-secret: <secret>)──▶ API Gateway
                                                                         │
                                                                         ▼
                                                              [Lambda: webhook]
   1. compare header secret to SSM /sb/<env>/orderdesk/webhook-secret  (else 401)
   2. parse full OrderDesk order JSON -> cleaned job (src/functions/webhook)
   3. PutItem META in DynamoDB + SendMessage to intake.fifo
                                                                         │
                                                                         ▼
                                                                   202 Accepted
```

The cleaned-job shape and OrderDesk field mapping live in
[`src/functions/webhook/index.mjs`](../src/functions/webhook/index.mjs). Field
paths are best-effort (from a sample order) and marked `TODO` until confirmed
against the live API. Facility routing is delegated to
[`src/shared/routing.mjs`](../src/shared/routing.mjs), which is **data-driven**:
NV/CA come from seeded zip dictionaries; GA/NJ/TX rules are filled in later with
**no code change**.

### New secret

`/sb/<env>/orderdesk/webhook-secret` — the shared secret OrderDesk sends with
each webhook. Seed it (and configure the same value in OrderDesk's webhook
settings) the same way as the other credentials; the repo never holds the value.

## Proof approval (Week 8)

When an order needs a proof, the Step Functions pipeline pauses at
`WaitForApproval` and the `request-approval` Lambda stores the task token on the
order (`SK=APPROVAL`). A reviewer then resumes it:

```
reviewer ──POST /orders/{name}/approve|reject (JWT)──▶ [Lambda: approval]
   1. read the order's APPROVAL token from DynamoDB
   2. approve -> SendTaskSuccess(token)   pipeline continues to transfer/notify
      reject  -> SendTaskFailure(token)   pipeline takes its failure path
   3. mark APPROVAL status approved/rejected
```

Two routes (not one `/review` with a body) keep intent explicit in the URL and
leave room for per-route authorization later (e.g. reject restricted to a
Cognito group). `SendTaskSuccess`/`SendTaskFailure` aren't resource-scoped, so
the `approval` Lambda holds those actions on `*` plus DynamoDB read/write.
Already-decided or expired tokens return `409`/`410`.

## Auth (`sb-<env>-auth`, Cognito)

- **User Pool** `sb-<env>-users`: email sign-in, **self-signup disabled**
  (admins create staff accounts), 12-char password policy with all character
  classes, email-only recovery.
- **App Client** (`-web`): public client (no secret), 1-hour access/ID tokens,
  30-day refresh, SRP auth flow.
- Free up to 50,000 MAU => **$0**. Prod retains the pool on stack deletion; dev
  destroys it.

## Deploy

```bash
npx cdk deploy sb-dev-auth sb-dev-compute sb-dev-api --context env=dev
```

`sb-<env>-api` depends on the `webhook`/`order-api` Lambdas (compute stack) and
the Cognito pool (auth stack). All free-tier => $0.
