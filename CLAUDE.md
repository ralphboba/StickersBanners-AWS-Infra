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
- **No customer approve/reject or file upload** — revisions happen over email.
- **Pipeline ends at the production folder** (`pickup_*`); production owns
  "completed". Don't build a completed transition.
- **Zendesk** proof-ready email is the only external notification (Google Chat off).
- Intake is by **polling** the OrderDesk QTS folder (no webhook).

## Safety
- dev uses REAL production credentials. Never process real orders without explicit
  go-live approval. The real poll schedule (`sb-dev-poller`) stays DISABLED.
- Demo sandbox: synthetic `DEMO-*` orders + display-only mirror of real orders.
  `DEMO-*`/`ZZ-*` orders never send real email or transfer (hard guard).
- Rotate all pasted keys (OrderDesk/FTP/Zendesk) before real go-live.

## Working agreement
- Branch: `claude/stickerbanners-aws-cdk-fw49s2`. Commit + push when work is done.
- $0 / free-tier first. Ask before hard-to-reverse or outward-facing actions.
