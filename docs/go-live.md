# Go-live runbook

Taking over from Linh's program, one switch at a time. Nothing here happens
without Kai's explicit approval at each stage.

## The four switches

Each is independent, and each is off today. That is deliberate: it means every
stage can be turned on, watched, and turned back off on its own.

1. **`sb-dev-poller` schedule** — DISABLED. Off, no real order enters the
   pipeline at all. (The `sb-dev-mirror-sync` schedule is separate, enabled, and
   read-only: it copies real orders onto the dashboard for display and never
   processes them.)
2. **`ZENDESK_SENDS`** — `disabled`. The only code that contacts a customer.
3. **`approval/link-secret` + `approval/portal-base`** — unseeded. The customer
   approval path (`docs/customer-approval.md`).
4. **`PRODUCTION_TRANSFER`** — `disabled`. The only code that puts print files
   in front of the production team. Missing from the first version of this list,
   which was a real gap: everything else was held, so "run a real order through"
   read as safe when it would in fact have uploaded to the facility.
5. **`ORDERDESK_WRITES`** — `disabled`. The only code that moves a real order in
   OrderDesk. **This is the actual handover point with Linh's program.**

⚠️ Switches 1, 2 and 5 are Lambda environment variables and take effect on
`cdk deploy`. Switch 4 lives in an ECS **container image**, which is built only
by `build-images.yml` on the working branch — deploying the stack sets the
variable, but the running image only honours it once that workflow has pushed a
new `:latest`. Check the image before trusting the switch.

## What enforces this

Kai: "절대로 내가 라이브화 하라고 하기 전까지 일어나지 않는 일들은 일어나면
안된다." So the holds are not a matter of remembering. Three layers:

1. **`test/safety-switches.test.ts`** asserts, against the SYNTHESIZED
   CloudFormation, that all four switches are `disabled` — in prod as well as
   dev, so a prod deploy is not a way around it. Nothing enforced this before:
   flipping any switch to `enabled` in the source would have passed CI in
   silence and shipped on the next deploy. Verified by flipping all four (6/6
   fail).

   **If one of those tests fails, that is the point.** Do not "fix" the test.
   Either the flip is a mistake, or it is a deliberate go-live and that diff is
   the record of the decision.

2. **`.claude/settings.json` deny rules** block every way to arm a switch
   without going through code review: `lambda update-function-configuration`,
   `ecs register-task-definition`, `ecs run-task` (its `--overrides` can set
   env vars directly), `scheduler update-schedule`, `ssm put-parameter`, plus
   `stepfunctions start-execution` and `sqs send-message`, which inject an
   order into the pipeline without any switch at all.

3. **The poller's allow rule is scoped to `--payload {"dryRun":true`.** It used
   to permit any payload, which meant a single invocation with no `dryRun` would
   have processed real orders end to end. A real-order run now needs an explicit
   approval at the moment it happens.

None of this constrains Kai — it constrains everything that is not a deliberate,
visible decision.

## Before stage 0: what is not done yet

- **No real order has ever been through this code.** Every test to date is
  synthetic. Stage 1 exists to fix exactly that.
- **Credentials are not rotated.** OrderDesk / FTP / Zendesk keys were all
  pasted into chat. Rotate before stage 2, not after.
- **`dev` uses REAL production credentials.** There is no separate prod
  deployment. "Turning it on in dev" means real orders move.
- **`awaiting_payment` (folder `3926`) is missing from `MIRROR_FOLDERS`**, so
  that column always reads 0 on the dashboard. Cosmetic, but don't read it as
  "no orders awaiting payment".

## Stage 0 — deploy. Nothing moves.

```
npx cdk deploy --all --context env=dev
```

All four switches are off, so this changes no behaviour. What it does is put the
*current* code on AWS — the deployed Lambdas predate PRs #9, #10 and #11, so
until this runs, any observation is of stale code.

Check afterwards: the dashboard still loads, the mirror still updates.

## Stage 1 — dry-run. Read-only.

```
aws lambda invoke --function-name sb-dev-poller \
  --payload '{"dryRun":true,"limit":25}' --cli-binary-format raw-in-base64-out \
  /dev/stdout
```

Reads real OrderDesk orders, **writes nothing and enqueues nothing**, and
returns what it computed for each: variant (QTS vs Shopify), routing decision,
express upgrade, hardware filtering, finishing, dimensions, and what the intake
gate would have done.

This is the comparison that has never been run: put it next to what Linh's
program did with the same orders. Disagreements are found here, on paper, or
they are found later on a real customer's job.

Do not go past this stage until the dry-run matches.

## Stage 2 — real orders through the full pipeline, email held

Rotate credentials first, then enable the poll schedule:

```
aws scheduler update-schedule --name sb-dev-poller --state ENABLED   # (plus its existing target/flexible-window args)
```

`ZENDESK_SENDS`, `PRODUCTION_TRANSFER` and `ORDERDESK_WRITES` all stay
`disabled`. So a real order goes: intake → gate → resize → finish → proof
generated → **stops**. The proof
email is composed in full and logged as "WOULD HAVE BEEN SENT" with the real
recipient, subject, body and signed approval link. Nobody is contacted, and no
order moves in OrderDesk.

What to check:
- The generated TIFFs against Linh's for the same order — byte-identical is the
  bar, and that validates the whole image pipeline in one comparison.
- The held email log lines: right customer, right order, right link.
- The intake gate's "WOULD HAVE RUN" lines against where Linh's program actually
  filed each order.

Rollback is disabling the schedule again. Orders already in flight will finish
their processing and park at the approval gate; nothing reaches a customer.

## Stage 3 — customer approval path

Seed the two SSM parameters (`docs/customer-approval.md`). Still no email is
going out at this point, so this is safe to do early — it only decides *which*
link a future email would carry.

## Stage 4 — arm the customer email

`ZENDESK_SENDS=enabled`. Real customers now receive proof emails from this
system.

⚠️ Linh's program is presumably still emailing them too. Coordinate: either his
proof step is off by now, or customers get two emails for the same order.

## Stage 5 — arm the OrderDesk write. The handover.

`ORDERDESK_WRITES=enabled`.

⚠️ **Do not run this alongside Linh's program.** Both would move the same orders
between folders and fight each other. This switch and his program being off are
the same decision.

## Stage 6 — Linh's program off

At this point every path a customer or an order can take runs through this
system. Keep the dashboard watched for the first days; the mirror no longer
means "someone else is handling it".

## The Sunday 2026-09-13 window (16:00–21:00 UTC)

Linh agreed to stop his QTS scanning for five hours — noon to 5PM **New York**
time — while leaving his API up so customers can still see and approve proofs on
his portal. His one condition, verbatim:

> "Also create separate folders when you test in case something goes wrong so we
> don't have to figure out which orders need to be processed again"

This is the first window in which our pipeline can run on live orders without
racing his program for the same folder.

### What the window is actually for

Not the decision layer — that is already verified on 374 real orders in a single
day, with the routing, the intake gate, the proof verdict, the finishing parse
and both express branches all confirmed against live data. What has **never**
run on a real order is everything after it: resize, finish, proof. Those have
only ever seen `DEMO-*` orders carrying one synthetic image from our own bucket.
So the goal is the image pipeline on real customer artwork, and nothing beyond
it. `ZENDESK_SENDS` and `PRODUCTION_TRANSFER` stay `disabled` throughout —
customers keep using Linh's portal, and no print file goes near a facility.

### The express window overlaps, and that decides the running order

The 3–6pm ET express cutoff is 19:00–22:00 UTC, so the last two hours of the
test sit inside it. That matters because the express upgrade is not a folder
move — `applyExpressUpgrade` rewrites `shipping_method` on the real order and
appends an order note. A folder move is trivially reversible; an edited order
record is what Linh's program sees when it comes back at 5PM.

So any phase with `ORDERDESK_WRITES` armed runs **before 19:00 UTC**:

| UTC | ET | `ORDERDESK_WRITES` | What it proves |
|---|---|---|---|
| 16:00–17:00 | 12–1pm | `disabled` | Image pipeline on real artwork. Nothing is written to OrderDesk at all, so the orders stay in QTS and Linh processes them normally at 5PM. Zero risk. |
| 17:00–19:00 | 1–3pm | `enabled` | Folder move and tag, into the test folders. Outside the express window, so no order record is edited. |
| 19:00–20:30 | 3–4:30pm | `disabled` | Express window open: the NV pull and the 3-day upgrade are decided and logged, not written. |
| 20:30–21:00 | 4:30–5pm | `disabled` | Restore, verify, hand Linh the manifest. |

Arming `ORDERDESK_WRITES` for the middle phase is a go-live action and needs
Kai's explicit approval on the day. Declining it costs little: the first phase
alone covers the gap the window exists to close.

### Prepared in advance

- **Artwork download bounds** (`src/services/resize/fetch.py`). The HTTP fetch
  was a bare `urlretrieve` with no timeout, no size cap and no retry — three
  ways one uncooperative server could eat the window. Now bounded and retried;
  see the module for the reasoning and `test/python/test_artwork_fetch.py` for
  the failure modes it pins.
- **Restore script** (`scripts/restore-folders.mjs`). Linh's condition, met:
  moves everything out of the test folders back to QTS. Dry run by default,
  `--apply` to act, `--out` writes the manifest to hand him. Must run somewhere
  that can reach app.orderdesk.me — the dev container's egress proxy blocks that
  host, so not from here.

### Still needed before the window

- The **test folder IDs**. `ORDERDESK_FOLDERS` in `src/shared/intake-gate.mjs`
  is a hardcoded map, so pointing the gate at test folders is a code change and
  a deploy, not a setting. Needs the eight ids (manual, sales, processing,
  proofing, GA, NJ, TX, NV) created in OrderDesk first.
- **`SKU-603` and `SKU08X08FPUD`** confirmed as inches. Both are the fabric
  pop-up display family at 115x91 and both still resolve to feet. Every pop-up
  display order seen so far is held at the gate as `special-product`, so none
  reaches print automatically — but the window is the first time these become
  real print files rather than a line in a report.
- **Pause the demo feeder** for the five hours. It runs every 10 minutes and
  would interleave synthetic executions through the logs we need to read.

---

## Runbook: the 2026-09-13 window, as decided

Kai's decision, in his words: *"5시간동안 정말로 go-live시키는거야"* — a real
five hours, with orders moved into OrderDesk folders he created, real Zendesk
proof emails to real customers, and print files diverted to a review path so a
person sees them before production does.

All times **America/New_York (EDT)**; the UTC equivalent is in brackets because
every AWS console and log is in UTC.

### The shape of it

| | |
|---|---|
| Orders leave | the QTS folder (665685) — so Linh's scanner will not redo them |
| Orders land in | `Kai-TEST-processed` 711436, `Kai-TEST-manual` 711437, `Kai-TEST-sales` 711438 |
| Customers get | a real proof email with a link to **our** approval page |
| Print files go to | `/AWS-TEST/{facility}/{order}` — **not** the facility folder |
| Production prints | nothing automatically. A person promotes the files afterwards |

Why the print files divert: the run is real in every respect a person can check
afterwards, and the one irreversible step — a file appearing where the GA/NJ/TX
team collects work — keeps a human in front of it. Our output was compared
against Linh's real files on 2026-09-12 and matched to the pixel, but that
comparison covered two finishing families out of seven.

### Before noon

Already done on the night of 09-12, all with every switch still held:

- `sb-dev-compute`, `sb-dev-api`, `sb-dev-webapp`, `sb-dev-ecs` deployed
- the four container images rebuilt and **probed in a running task** —
  `PROOF_DIR=/Proof`, `remote_path` honouring the prefix, transfers still off
- `GET /proof` and `POST /proof/approve` live, correctly returning 503
  ("Approvals are not available yet") until the two parameters are seeded
- the armed synth checked: the flags produce exactly the values above

### Noon [16:00 UTC] — arm

Run in this order. Each step is independently reversible.

1. Deploy with the flags:

```
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npx cdk deploy sb-dev-compute sb-dev-ecs \
  --context env=dev --require-approval never \
  -c armOrderDeskWrites=true \
  -c armZendeskSends=true \
  -c armProductionTransfer=true \
  -c orderDeskFolderIds='{"processing":"711436","manual":"711437","sales":"711438"}' \
  -c ftpBasePath=/AWS-TEST
```

2. Seed the customer approval path (this is what turns the 503 into a page):

```
aws ssm put-parameter --name /sb/dev/approval/link-secret --type SecureString \
  --value "$(openssl rand -hex 32)" --region us-east-1
aws ssm put-parameter --name /sb/dev/approval/portal-base --type String \
  --value https://d1z2r5w66e9a93.cloudfront.net/proof.html --region us-east-1
```

3. Start the intake:

```
aws scheduler update-schedule --name sb-dev-poller --region us-east-1 --state ENABLED \
  ... (the CLI requires the full schedule definition; read it first with get-schedule)
```

Then verify, before walking away: the poller's environment shows
`ORDERDESK_WRITES=enabled`, the first order to arrive moves to 711436, and the
Zendesk log line says SENT rather than "WOULD HAVE BEEN SENT".

### 5PM [21:00 UTC] — disarm

The whole point of making arming a flag: disarming is the same command with the
flags removed. Nothing has to be remembered or edited.

```
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY npx cdk deploy sb-dev-compute sb-dev-ecs \
  --context env=dev --require-approval never
aws scheduler update-schedule --name sb-dev-poller --region us-east-1 --state DISABLED ...
```

**The two approval parameters stay.** Kai chose this deliberately. The link in
every email already sent is signed with that secret, and customers answer on
their own schedule — deleting it at 5PM would kill every outstanding link. The
page is reachable only with a valid signed link; there is no index and no login,
so leaving it up costs nothing.

### Afterwards

1. Inspect `/AWS-TEST` with the read-only FTP tool
   (`src/services/ftp/ftp_inspect.py`) and check every file's pixel size, dpi
   and mode against what the order data says it should be.
2. Promote the files a person is happy with into the real facility folders.
   Until that happens those orders are **not printed** — that is the trade the
   review path buys.
3. Orders sitting in the three Kai-TEST folders are the record of what this
   system did. The ones in `-manual` and `-sales` still need a person, exactly
   as they would have in Linh's flow.

### What is still unverified going in

- Finishing families other than Hem & Grommets and Pole Pocket Top Only: PPTB,
  PPBO, RET, GO, CO, HO have no side-by-side against Linh's output.
- Whether his program re-sends a proof email for an order it reprocesses. It
  should not come up — the orders leave his queue — but it is the assumption
  behind that claim, and only he can confirm it.
- `SKU-603` and `SKU08X08FPUD` are still resolved as feet. The oversize gate
  (MAX_SIDE_INCHES) now catches SKU-603 at 1380 in and holds it for a person, so
  it cannot reach print — but the underlying SKU entry is still missing.
