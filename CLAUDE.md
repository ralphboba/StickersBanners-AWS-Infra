# StickersBanners AWS Infra — project memory

Migrating the legacy single-PC order pipeline (SBBotExpress + SBImageProcessor)
to AWS (CDK/TypeScript). Owner: Kai (timothy@stickersbanners.com). Domain
authority: **Linh** (legacy author).

## Read this first
- **`docs/shipping-change-spec.md`** — the customer shipping change ("Manage my
  order"): Kai's rules (e.g. ONLY Completed Orders is closed; never move OD
  folders; Shopify prices; options never preselected), the full workflow, and
  every case that is allowed or refused. Read it before touching that code;
  update it in the same commit when a rule changes.
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
  Exception (Kai, 2026-10-06): the reconciler (`shipping-change-reconcile`,
  every 5 min) posts to the "shipping upgrade" space
  (SSM `gchat/webhook-url-alerts`, falls back to `gchat/webhook-url`) when a
  PAID change is still not in Order Desk after 30 min, or a change is flagged
  for a person. It also settles paid changes the webhook missed (same code).
  Exception (Kai, 2026-10-04): when the customer picks a shipping change and the
  order edit is committed, Shopify's own invoice email (`orderInvoiceSend`) to
  the order's address — updated order, balance, Pay now. Only while there is a
  balance (Shopify refuses one for a paid order). Behind `SHOPIFY_WRITES`
  (+ `WRITE_ONLY_ORDERS`) (`order-status-api/routes.mjs` requestChange).
- Intake is by **polling** the OrderDesk QTS folder (no webhook).

## Safety
- dev uses REAL production credentials. The real poll (`sb-dev-poller`, every
  1 min) is ON since Kai enabled it on 2026-09-29 — image processing only; in
  code as `intakePollEnabled` (dev only, prod stays off). Real orders run the
  pipeline; the three switches below keep them away from OrderDesk, customers
  and facilities. Arming any of those needs Kai's explicit go-live approval.
- **Three write switches, all `disabled`** (`src/shared/write-gates.mjs`). Each is
  an exact match on `"enabled"`; `DEMO-*`/`ZZ-*` can never write regardless of any
  of them. Arming any one is a go-live action needing Kai's explicit approval.
  - `ORDERDESK_WRITES` — every OrderDesk folder/tag move (`orderdesk-write.mjs`,
    ported from Linh's `updateOrderdeskDetails`): the intake gate's move in the
    poller, and the pipeline's later moves in `orderdesk-move` (Processing →
    Proofing → Pending Review → facility, Linh 2026-10-05). The decisions always
    run and are recorded; only the write is held back. **Stays off.**
  - `ORDERDESK_UPGRADE_WRITES` — the customer shipping upgrade's `shipping_method`
    PUT. Runs only *after* the customer has paid.
  - `SHOPIFY_WRITES` — invoicing / order editing. **This one moves real money.**
  - Customer shipping change (`ORDERDESK_UPGRADE_WRITES` + `SHOPIFY_WRITES` on
    the change functions only): `--context testOrders=S64262` arms them for the
    listed orders; `--context shippingChange=live` arms them for **every** order
    (Kai approved, 2026-10-04). Since 2026-10-05 the "Manage my order" button
    in Shopify's confirmation template is shown to EVERY customer — this is
    live with real customers (first real paid change: S66881, 2026-10-07).
    Neither context = off. `ORDERDESK_WRITES` is not affected by either.
  - Add-ons on the customer page (Kai, 2026-10-08): OFF unless named —
    `--context addOnOrders=S64262` (those orders only, while testing) or
    `--context addOns=live` (every order). They use the same write switches
    as the shipping change (`docs/shipping-change-spec.md` §8).
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
- **Test lane** (Kai, 2026-10-07, `src/shared/test-lane.mjs`, dev only via
  `testLaneEnabled`): an order Kai moves by hand to OrderDesk **Kai-TEST-QTS**
  (715303) runs for real despite the held switches — but only into test
  destinations: Kai-TEST-* folders, the proof email to the order's own address
  ([TEST] subject), FTP `/AWS-TEST/...`, CA Drive `AWS-TEST` folder. The poller
  takes over (and stops) the real lane's run of that order. Real orders never
  carry `testLane`; prod has `TEST_LANE=disabled` (safety test).
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
- Branch: `claude/order-modification-automation-li1gja`. Commit + push when work is done.
- Reply to Kai in Korean. Do only what he asks — no extra functions.
- $0 / free-tier first. Ask before hard-to-reverse or outward-facing actions.
