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
  handler delete its alarm the next time it fires (log event `alarm.disabled`). Every handler
  checks it first, via `haltIfAlarmsDisabled` or `guardedAlarmFor`. For a one-shot cleanup handler
  this means the cleanup does not run until the account re-arms it; an abandoned connect attempt
  keeps its storage until then.
- **`guardedAlarm`.** Wraps a re-arming handler: at most 120 runs per clock hour (then
  `alarm.circuit.open`), and a throwing run is swallowed and replaced by an exponential-backoff
  alarm (30 s doubling to 1 h, `alarm.failed`), giving up after 8 consecutive failures
  (`alarm.gave_up`). A guarded handler therefore no longer rethrows to the platform. All of ours
  set `deferWhenOpen`, so an open circuit re-arms for the next hour instead of dropping the work.
- **`scheduleAlarm`.** Arms an alarm no earlier than `now + 1 s`. Exported for new code; no
  existing handler uses it, because the ones that deliberately re-arm "at once" (scheduler
  revocation cleanup, Google hook renewal) are covered by the circuit breaker, and their tests
  pin the immediate behavior.
- **`guardedAlarmFor(ctx, env, key, run)`.** The one-line seam our handlers call: `guardedAlarm` with the kill switch read from `env` and `deferWhenOpen` on.
- **Coverage test.** `scripts/fork/alarm-guard-coverage.test.ts` fails when a source file defining
  `async alarm(` does not reference the guard. It checks per file, not per class.

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
| `workshop-backend` `OverseerDurableObject` (`overseer.ts`, `runAlarmTasks`) | `#updateAlarm` re-arms at `now` while an external-message response is ready, and at the agent keep-alive time | a response that can never be delivered, or a drain that keeps failing, re-arms at `now` and rethrows: a tight loop | `guardedAlarm` key `overseer`, `deferWhenOpen` | GUARDED. The breaker bounds the loop; it does not remove the undeliverable record. |
| `gatekeeper-scheduler` `ScheduleDriver` | recovery alarm before each pass, then the earliest schedule time; `now` while a revoked account still has storage | a schedule whose firing fails permanently re-runs forever | `guardedAlarm` key `scheduler`, `deferWhenOpen` | GUARDED. The guard's counter key is ignored when revocation cleanup checks for remaining data. The revoked-account cleanup is one pass per alarm, and a large account is slowed to the hourly cap if it needs more than 120 passes. |
| `gatekeeper-google` `ChatHookDriver` (`chat-hooks.ts`) | `#reschedule` to the earliest of queue retry, subscription renewal or expiry | failures are caught per message and renewal and write a later time first | `guardedAlarm` key `google.chat-hooks`, `deferWhenOpen` | GUARDED |
| `gatekeeper-google` `GmailHookDriver` (`gmail-hooks.ts`) | `#reschedule`; `syncAt` and `watch.renewAt` default to `now` when unset | a sync or watch step that throws leaves them at `now` | `guardedAlarm` key `google.gmail-hooks`, `deferWhenOpen` | GUARDED |

## Rules for new alarm code

1. Every `async alarm(` starts with the kill switch: `haltIfAlarmsDisabled(this.ctx, this.env, key)`,
   or `guardedAlarm(..., { disabled: alarmsDisabled(this.env) })`. The coverage test enforces this
   per file.
2. A handler that re-arms itself uses `guardedAlarm` (with `deferWhenOpen` when stopping would
   lose work) and arms with `scheduleAlarm`, so no failure path re-arms at `now`.
3. Add the handler to the tables above.
