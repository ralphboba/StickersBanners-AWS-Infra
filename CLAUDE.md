# StickersBanners AWS Infra — project memory

Migrating the legacy single-PC order pipeline (SBBotExpress + SBImageProcessor)
to AWS (CDK/TypeScript). Owner: Kai (timothy@stickersbanners.com). Domain
authority: **Linh** (legacy author).

## Read this first
- **`docs/linh-requirements.md`** — Linh's own answers (routing, credentials,
  behaviour) = the spec the system must match. Do not forget these.

## Non-negotiables Linh set
- **Routing**: NV/CA by ZIP; **GA/NJ/TX ship by state** (state lists still to be
  captured — derive from real orders in the facility folders).
- **Customers approve, but never reject and never upload.** Linh: "i said i
  didn't see the point in disapproving, not not letting them approve … right now
  they'd still need to approve via the portal." Approval happens on
  `proof.stickersbanners.com`; revisions come back by email. Do NOT add a reject
  button or a customer upload path.
- **Pipeline ends at the production folder** (`pickup_*`); production owns
  "completed". Don't build a completed transition.
- **Zendesk** proof-ready email is the only external notification (Google Chat off).
- Intake is by **polling** the OrderDesk QTS folder (no webhook).

## Safety
- dev uses REAL production credentials. Never process real orders without explicit
  go-live approval. The real poll schedule (`sb-dev-poller`) stays DISABLED.
- **Three write switches, all `disabled`** (`src/shared/write-gates.mjs`). Each is
  an exact match on `"enabled"`; `DEMO-*`/`ZZ-*` can never write regardless of any
  of them. Arming any one is a go-live action needing Kai's explicit approval.
  - `ORDERDESK_WRITES` — the intake gate's folder/tag move
    (`orderdesk-write.mjs`, ported from Linh's `updateOrderdeskDetails`). The gate
    itself always runs and the dashboard shows what it *would* do; only the write
    is held back. **Stays off** — routing still needs Linh's confirmation.
  - `ORDERDESK_UPGRADE_WRITES` — the customer shipping upgrade's `shipping_method`
    PUT. Runs only *after* the customer has paid.
  - `SHOPIFY_WRITES` — invoicing / order editing. **This one moves real money.**
- Demo sandbox: synthetic `DEMO-*` orders + display-only mirror of real orders.
  `DEMO-*`/`ZZ-*` orders never send real email or transfer (hard guard).
- Rotate all pasted keys (OrderDesk/FTP/Zendesk) before real go-live.

## Working agreement
- Branch: `claude/stickerbanners-aws-cdk-fw49s2`. Commit + push when work is done.
- $0 / free-tier first. Ask before hard-to-reverse or outward-facing actions.
