# Scheduler (Week 10)

Time-based automation via **Amazon EventBridge Scheduler** — the replacement
for the legacy BullMQ schedulers.

## What survives from the legacy schedulers

| Legacy BullMQ | Fate |
| --- | --- |
| `mainQueue` (30-min order poll) | → **`poller-fallback`** schedule here (see below) |
| `autoQueue` (10-min auto-routing) | **obsolete** — routing now happens inline when the webhook cleans each order (`src/shared/routing.mjs`), so there's nothing to re-scan every 10 min. Not recreated. |

Webhook (Week 6) is the primary intake; the poll is only a **safety net** for
orders a webhook delivery missed.

## The schedule (`sb-<env>-scheduler`)

Defined in [`lib/stacks/scheduler-stack.ts`](../lib/stacks/scheduler-stack.ts).

| Setting | Value |
| --- | --- |
| Name | `sb-<env>-poller-fallback` |
| Expression | `rate(15 minutes)` (configurable via `intervalMinutes`) |
| Target | `poller` Lambda |
| Flexible time window | OFF (fires exactly on the interval) |
| **State** | **DISABLED** |

### Two separate things: schedule state vs poller logic

- **Schedule state = DISABLED** — the schedule exists but does not fire (an
  alarm clock switched off). Flip it to `ENABLED` in the console/CLI when ready.
- **Poller logic = skeleton** — `src/functions/poller/index.mjs` doesn't call
  OrderDesk yet (returns 0 jobs).

Both must be ready before enabling: seed the OrderDesk credentials (SSM) and
fill in the poll logic, then enable the schedule:

```bash
aws scheduler update-schedule --name sb-dev-poller-fallback --state ENABLED \
  --schedule-expression 'rate(15 minutes)' --flexible-time-window '{"Mode":"OFF"}' \
  --target '{...}'   # or just toggle State in the console
```

### Why 15 minutes (and why not more often)

AWS cost is $0 at any interval (Scheduler: 14M invocations/mo free; Lambda:
1M/mo free — even 1-min = ~43k/mo). The real limiters are **OrderDesk API rate
limits** and redundant work: the webhook already catches orders in seconds, so
a tighter interval buys almost nothing while adding OrderDesk load and
dedupe/race pressure. 15 min is a safe safety-net cadence; change
`intervalMinutes` anytime.

## IAM

EventBridge Scheduler uses the `scheduler.amazonaws.com` principal (distinct
from the classic EventBridge Rules role, `events.amazonaws.com` — which is why
the IAM stack's `eventBridgeRole` doesn't apply here). The L2 `Schedule`
construct provisions a dedicated execution role scoped to `lambda:InvokeFunction`
on the poller only.

## Cost / safety

Free tier => **$0**. Ships DISABLED, so deploying it does nothing until
enabled. Not deployed yet (manual/approved deploys).
