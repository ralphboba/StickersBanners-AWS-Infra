# Customer proof approval

## The problem this solves

Until now our pipeline could pause for a proof but nobody outside the company
could release it.

The proof-ready email sends customers to `proof.stickersbanners.com`. That page
posts the approval to **Linh's** program, not ours — our `POST
/orders/{name}/approve` sits behind Cognito, so only staff can reach it. The day
Linh's program is switched off, every proofed order would sit at the gate until
the workflow's 7-day timeout killed it, with staff having to approve each one by
hand from the dashboard.

So the customer needs a path into *our* pipeline.

## The shape of it

```
proof made -> Zendesk email  ─ signed link ─>  web/proof.html
                                                    |
                                            GET  /proof?t=...      (view)
                                            POST /proof/approve    (approve)
                                                    |
                                        SendTaskSuccess(taskToken)
                                                    |
                                          workflow resumes -> route/transfer
```

Nothing about the workflow changes. The customer route resumes the exact same
paused execution the dashboard's "Send to production" button resumes; it just
comes from outside.

## What the customer can do — and only this

Linh's non-negotiables (`CLAUDE.md`) shape the whole surface:

| | exists? | where |
|---|---|---|
| View their proof | yes | `GET /proof?t=` (public) |
| Approve | yes | `POST /proof/approve` (public) |
| Reject / disapprove | **no** | staff-only `POST /orders/{name}/reject`, Cognito |
| Upload a revised file | **no** | exists nowhere in the system |

Revisions come back by email to `sales@stickersbanners.com`, exactly as they do
today. The page says so where the reject button would otherwise be.

Two tests pin this so it cannot regress quietly:
`test/api-stack.test.ts` asserts the full list of public route keys and that no
route key anywhere matches `/upload/` or `/reject/` outside the staff route, and
`test/compute-stack.test.ts` asserts the customer Lambda's role holds
`states:SendTaskSuccess` and **not** `states:SendTaskFailure` — so even a bug in
the handler cannot reject somebody's order.

## Authentication: the signed link

Customers have never had a login and inventing one now would strand every
existing customer, so the credential is the link itself
(`src/shared/approval-link.mjs`) — the same shape as an unsubscribe link:

```
v1.<base64url {"o":"<order>","e":<expiry>}>.<HMAC-SHA256 over the above>
```

- **It names exactly one order.** The handler takes the order name only from
  inside a verified token, never from the query string, body or path. There is
  no field to swap, so a customer cannot reach another customer's order.
- **It cannot be forged or edited** without the `approval/link-secret`.
- **It expires** after 14 days on its own. That deliberately outlives the
  workflow's 7-day approval wait, so a late click gets an honest "this order
  timed out" rather than a confusing "bad link".
- **A missing secret closes the door.** If `approval/link-secret` is not seeded
  the route answers 503. It never falls back to accepting unsigned requests.

Rotating the secret invalidates every link already sitting in a customer's
inbox — that is the emergency stop, and also why you don't rotate it casually.

## Switching over

The switchover is **two SSM parameters, not a deploy** — it has to be reversible
in seconds, and the webapp distribution depends on the API stack so its URL
could not have been passed into the compute stack without a dependency cycle
anyway.

```
/sb/<env>/approval/link-secret   any long random string (openssl rand -base64 48)
/sb/<env>/approval/portal-base   https://<webapp DashboardUrl>/proof.html
```

- **Both set** → the proof email carries a signed link to our page, and
  approvals land in our pipeline.
- **Either missing** → the email keeps pointing at `proof.stickersbanners.com`,
  exactly as today. Nothing changes while Linh's program is still the one
  running.
- **Half set** → treated as missing, and logged loudly. A link to our page
  without a valid token would show the customer a dead button.

Seed them with `scripts/seed-parameters.sh <env>` (`APPROVAL_LINK_SECRET`,
`APPROVAL_PORTAL_BASE`), or clear them to roll back.

### Before you seed them

This path only matters at go-live, and go-live has other gates. In particular
`ORDERDESK_WRITES` is still `disabled` and `sb-dev-poller` is still off, so
today nothing reaches the proof gate on its own. Seeding these two parameters
early is harmless — no email is being sent — but pointing customers at a page
whose pipeline can't finish the order is not. Treat it as part of the same
go-live decision.

## Open questions for Linh

1. Who hosts `proof.stickersbanners.com`, and can it be repointed at
   `web/proof.html`? If yes, customers keep the familiar domain and only the
   backend moves. If not, they get the CloudFront URL, which works but looks
   unfamiliar in an email — a custom domain (`proof.` CNAME + ACM cert) is the
   fix, and is the one piece here that isn't $0-free-tier automatic.
2. How the legacy portal authenticates customers today (`requireGeneralAuth`).
   If it is doing something we should preserve, this design should match it.
3. Whether the DZI deep-zoom viewer needs porting to our page. Ours currently
   renders the `_review.jpg` derivative the proof service already writes, which
   is what the email tells customers to zoom into; the legacy portal used the
   full tile pyramid. The tiles are already generated and served
   (`sb-dev-dzi` + CloudFront), so this is a page change, not a pipeline one.
