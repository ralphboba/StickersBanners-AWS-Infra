# StickersBanners AWS Infra — project memory

Migrating the legacy single-PC order pipeline (SBBotExpress + SBImageProcessor)
to AWS (CDK/TypeScript). Owner: Kai (timothy@stickersbanners.com). Domain
authority: **Linh** (legacy author).

## Read this first
- **`docs/linh-requirements.md`** — Linh's own answers (routing, credentials,
  behaviour) = the spec the system must match. Do not forget these.
- **`docs/pricing-and-tax.md`** — customer charges: shipping price AND tax both
  come from Shopify (`shopify-pricing.mjs`), never from a table in code (the PDF
  card was wrong on 17% of real orders). No quote unless we reproduce exactly
  what checkout charged. Money is integer cents (`money.mjs`).

## Non-negotiables Linh set
- **Routing**: NV/CA by ZIP; **GA/NJ/TX ship by state** (state lists still to be
  captured — derive from real orders in the facility folders).
- **Customers approve, but never reject and never upload.** Linh: "i said i
  didn't see the point in disapproving, not not letting them approve … right now
  they'd still need to approve via the portal." Revisions come back by email.
  Do NOT add a reject button or a customer upload path.
  Today approval happens on Linh's `proof.stickersbanners.com`, which posts to
  HIS program — so we also have our own path for when it is switched off:
  `web/proof.html` + public `GET /proof` / `POST /proof/approve`, authenticated
  by a signed link. See **`docs/customer-approval.md`**.
- **Pipeline ends at the production folder** (`pickup_*`); production owns
  "completed". Don't build a completed transition.
- **Zendesk** proof-ready email is the only external notification (Google Chat off).
  Exception (Kai, 2026-09-28): one Google Chat line per *paid* shipping change,
  sent after the Order Desk write succeeds (`src/shared/gchat.mjs`). Webhook URL
  is a secret — SSM, never committed.
  Exception (Kai, 2026-10-04): when the customer picks a shipping change and the
  order edit is committed, Shopify's own invoice email (`orderInvoiceSend`) to
  the order's address — updated order, balance, Pay now. Only while there is a
  balance (Shopify refuses one for a paid order). Behind `SHOPIFY_WRITES`
  (+ `WRITE_ONLY_ORDERS`) (`order-status-api/routes.mjs` requestChange).
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
- **`ZENDESK_SENDS` stays `disabled`.** It arms the only code that contacts a
  real customer (`src/shared/zendesk.mjs`). Held, the ticket is composed in full
  and logged ("WOULD HAVE BEEN SENT") with the real subject, body and signed
  approval link, and no credentials are even read — so real orders can run
  through the WHOLE pipeline (intake → resize → finish → proof) with nobody's
  inbox touched. Arming it is a go-live action needing Kai's explicit approval.
- **`PRODUCTION_TRANSFER` stays `disabled`.** It arms the only code that puts
  print files in front of the production team (`src/services/ftp/main.py` — real
  FTP to the facilities, real Google Drive for CA). Held, the transfer step logs
  "WOULD HAVE TRANSFERRED" and records itself done, so a real order can run the
  whole pipeline and stop at the facility's door. This one matters most while
  Linh's program is live: it is processing the same orders, so an unheld
  transfer means two copies of every print file, and the second is only "extra"
  until somebody prints it. `DEMO-*`/`ZZ-*` never transfer regardless.
  ⚠️ The guard lives in a CONTAINER, not a Lambda — it only exists in ECR after
  `build-images.yml` runs, which is restricted to the working branch. Verify the
  running image has it before trusting the switch.
- Demo sandbox: synthetic `DEMO-*` orders + display-only mirror of real orders.
  `DEMO-*`/`ZZ-*` orders never send real email or transfer (hard guard).
- **The customer approval path is off until `approval/link-secret` +
  `approval/portal-base` are seeded in SSM.** Both set = the proof email points
  at our page and approvals reach us; either missing = it keeps pointing at
  Linh's portal, exactly as today. Two parameters, no deploy, reversible in
  seconds — but it's still a go-live action (`docs/customer-approval.md`).
- Rotate all pasted keys (OrderDesk/FTP/Zendesk) before real go-live.
- Go-live is staged, one switch at a time — **`docs/go-live.md`** is the runbook.

## Working agreement
- Branch: `claude/stickerbanners-aws-cdk-fw49s2`. Commit + push when work is done.
- $0 / free-tier first. Ask before hard-to-reverse or outward-facing actions.
