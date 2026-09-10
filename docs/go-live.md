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
