# Durable Object alarm audit

Cloudflare has no hard spend cap. A Durable Object `alarm()` that fails (or finishes) and re-arms
itself at "now" runs as fast as the runtime can schedule it, and every run costs storage and
compute. This document lists every `alarm()` handler in `packages/`, how it can loop, and the
guard it has. Guard code: `@gadgets/observability/fork/alarm-guard` (re-exported to gatekeepers as
`@gadgets/gatekeeper-kit/fork/alarm-guard`). Approach ported from XcityUS/xct-os (Apache-2.0); the audit
below is ours. See "Alarm guards" in `docs/fork-maintenance.md` for the fork seam.

How Cloudflare handles alarms:

- When `alarm()` throws, the runtime retries with exponential backoff (about 2 s, up to about 6
  retries).
- A `setAlarm()` made during the handler arms a new alarm whether or not the handler then throws,
  so a handler that re-arms at `now` skips the platform backoff.
- An alarm whose time is past fires almost at once.

## The guard

- **Kill switch.** Setting the Worker var `ALARMS_DISABLED` to `"true"` and redeploying makes every
  handler skip its work the next time it fires (log event `alarm.disabled`) and re-arm an hourly
  probe. Clearing the variable and redeploying therefore resumes everything within the hour with
  no per-object recovery: a redeploy does not invoke Durable Objects, so deleting the alarm
  instead would leave scheduled work dormant. Every handler checks it first, via
  `haltIfAlarmsDisabled` or `guardedAlarmFor`. While it is on, each object with an alarm costs one
  trivial run an hour; a one-shot cleanup is deferred, not lost.
- **`guardedAlarm`.** Wraps a re-arming handler: at most `maxPerMinute` runs per clock minute, 6,000 by default, as a flood detector (then
  `alarm.circuit.open`), and a throwing run is swallowed and replaced by an exponential-backoff
  alarm (30 s doubling to 1 h, `alarm.failed`), giving up after 8 consecutive failures
  (`alarm.gave_up`; an alarm armed meanwhile is kept but pushed out to an hour, never deleted, so a
  concurrent request's wake-up is not lost). A run that succeeds and leaves no alarm armed deletes the guard's counter key, so an idle object returns to empty storage (a failing or given-up alarm keeps it). A guarded handler therefore no longer rethrows to the platform. A retry never postpones an alarm armed earlier than the backoff, such as a concurrent request's new work; a body that re-arms at once and keeps failing is stopped by the failure limit instead (8 fast runs, then hourly). All of ours
  set `deferWhenOpen`, so an open circuit re-arms for the next minute instead of dropping the work.
- **`scheduleAlarm`.** Arms an alarm no earlier than `now + 1 s`. Exported for new code; no
  existing handler uses it, because the ones that deliberately re-arm "at once" (scheduler
  revocation cleanup, Google hook renewal) are covered by the flood detector, and their tests
  pin the immediate behavior.
- **`guardedAlarmFor(ctx, env, key, run)`.** The one-line seam our handlers call: `guardedAlarm` with the kill switch read from `env` and `deferWhenOpen` on.
- **Coverage test.** `scripts/fork/alarm-guard-coverage.test.ts` fails when any `alarm()`
  method, `async` or not, does not call the guard in its own body. Comments and strings do not count.

## Handlers

Audited on branch `port/alarm-guards` (2026-10). Verdicts: SAFE (cannot loop), GUARDED (can
re-arm; the circuit breaker and backoff bound it).

### Connect-flow timeouts

`setCallback()` arms a one-shot alarm (1 h, or 2 min for an auth-only grant) while the account is
not connected. A completed connect or `revoke()` deletes it. When it fires the handler calls
`deleteAll()` if the flow never finished and never re-arms. Kill switch only.

| Handler | Key | Verdict |
|---|---|---|
| `gatekeeper-cloudflare` `UserAccount` | `cloudflare.connect-timeout` | SAFE |
| `gatekeeper-confluence` | `confluence.connect-timeout` | SAFE |
| `gatekeeper-email` | `email.connect-timeout` | SAFE |
| `gatekeeper-github` | `github.connect-timeout` | SAFE |
| `gatekeeper-gitlab` | `gitlab.connect-timeout` | SAFE |
| `gatekeeper-google` `UserAccount` | `google.connect-timeout` | SAFE |
| `gatekeeper-homeassistant` | `homeassistant.connect-timeout` | SAFE |
| `gatekeeper-linear` | `linear.connect-timeout` | SAFE |
| `gatekeeper-notion` | `notion.connect-timeout` | SAFE |
| `gatekeeper-slack` | `slack.connect-timeout` | SAFE |
| `gatekeeper-spotify` | `spotify.connect-timeout` | SAFE |
| `gatekeeper-supabase` | `supabase.connect-timeout` | SAFE |
| `gatekeeper-zoominfo` | `zoominfo.connect-timeout` | SAFE |
| `mcp-shared` account base (both MCP gatekeepers) | `mcp.connect-timeout` | SAFE |

### Other handlers

| Handler | Re-arm | Risk | Guard | Verdict |
|---|---|---|---|---|
| `workshop-backend` `PendingLogin` (`auth/login-flow.ts`) | none; one alarm at the result's expiry | deletes one key | kill switch | SAFE |
| `workshop-backend` `UserDurableObject` handoff sweep (`user.ts`) | `#armHandoffSweep` re-arms for the next pending expiry | each run deletes the records that are due, so the next time is in the future; an unlistable record re-arms a full lifetime ahead | kill switch | SAFE |
| `workshop-backend` `OverseerDurableObject` (`overseer.ts`, `runAlarmTasks`) | `#updateAlarm` re-arms at `now` while an external-message response is ready, and at the agent keep-alive time | a response that can never be delivered, or a drain that keeps failing, re-arms at `now` and rethrows: a tight loop | `guardedAlarmFor` key `overseer` | GUARDED. The breaker bounds the loop; it does not remove the undeliverable record. |
| `gatekeeper-scheduler` `ScheduleDriver` | recovery alarm before each pass, then the earliest schedule time; `now` while a revoked account still has storage | a schedule whose firing fails permanently re-runs forever | `guardedAlarmFor` key `scheduler` | GUARDED. The guard's counter key is ignored when revocation cleanup checks for remaining data. A large revoked account's cleanup is one pass per alarm, well inside the cap. |
| `gatekeeper-google` `ChatHookDriver` (`chat-hooks.ts`) | `#reschedule` to the earliest of queue retry, subscription renewal or expiry | failures are caught per message and renewal and write a later time first | `guardedAlarmFor` key `google.chat-hooks` | GUARDED |
| `gatekeeper-google` `GmailHookDriver` (`gmail-hooks.ts`) | `#reschedule`; `syncAt` and `watch.renewAt` default to `now` when unset | a sync or watch step that throws leaves them at `now` | `guardedAlarmFor` key `google.gmail-hooks` | GUARDED |

## Flood threshold

The breaker is a flood detector, not a rate limiter. It counts runs per clock minute and opens at
`MAX_ALARM_RUNS_PER_MINUTE` (6,000), the same for every handler. A runaway re-arm loop makes
thousands of runs a minute, so this stops it, while legitimate traffic stays far below it. The
busiest legitimate alarm is the scheduler: 500 enabled schedules (`MAX_ENABLED_SCHEDULES_PER_ACCOUNT`)
at the 60 s minimum (`MIN_INTERVAL_MS`) is at most 500 firings, so about 500 runs, in a minute, a
twelfth of the threshold. Other handlers are lower: the overseer runs once per ended agent turn
plus a 60 s keep-alive; a Google hook driver runs once per push (Gmail documents at most one
notification a second per user, so 60 a minute) plus one drain run per 20 queued deliveries
(`MAX_DELIVERIES_PER_RUN`), which stays under the threshold for hundreds of registrations. Retries
add no runs the threshold has to cover: a failing run is replaced by an exponential-backoff alarm
(30 s doubling to 1 h, after 8 failures retries slow to hourly), and that backoff, not the threshold, is what
stops a loop that throws. The run is counted before it starts, so a run killed by the runtime
(CPU limit, eviction) still counts.

A workload that legitimately nears the threshold is not a loop: raise the constant.

## Setting the kill switch

`ALARMS_DISABLED=true` is a plain-text Worker var read from `env`. It is not declared in any
`cloudflare.config.ts` or release manifest: like `ADMINS` and `DISABLE_PASSWORD_AUTH` it is
per-instance state, set where the deploy service sets other instance vars, and manifest-lib
deliberately does not template those. To halt alarms an operator must set it on every Worker that
defines an alarm: `workshop-backend`, `gatekeeper-scheduler`, `gatekeeper-google`, and the
cloudflare, confluence, email, github, gitlab, homeassistant, linear, notion, slack, spotify,
supabase, zoominfo, mcp and mcp-portal gatekeepers. A Worker without the var keeps running its
alarms. Whether the deploy service can set an arbitrary var on every Worker of an instance is
outside this repository; confirm that before relying on the switch. Locally, set it in the Worker's
`vars` in a dev config. Clearing the var and redeploying resumes everything within the hour (see
the kill-switch bullet above).

## Rules for new alarm code

1. Every `alarm()` handler starts with the kill switch: `haltIfAlarmsDisabled(this.ctx, this.env, key)`,
   or `guardedAlarm(..., { disabled: alarmsDisabled(this.env) })`. The coverage test enforces this
   per file.
2. A handler that re-arms itself uses `guardedAlarm` (with `deferWhenOpen` when stopping would
   lose work) and arms with `scheduleAlarm`, so no failure path re-arms at `now`.
3. Add the handler to the tables above.
