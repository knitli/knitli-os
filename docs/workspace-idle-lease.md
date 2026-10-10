# Workspace idle lease

A workspace's Overseer Durable Object bills for wall-clock duration while it is resident. A browser
that dies without closing its socket (laptop lid, killed tab, lost network) leaves the front Worker
holding the capabilities `open()` returned, and holding them keeps the Overseer resident for hours
at zero traffic. No event ever runs in that Worker again, so only the Overseer's own alarm can
notice. The lease is that alarm.

## Behaviour

- A call a browser makes through a capability the Overseer handed it (the workspace interface,
  gadget and gatekeeper capabilities, and calls through a gadget UI's facet stub) renews a 10-minute
  lease. `open()` arms it. Pings, the user's workspace list, the agent, hooks, gatekeeper callbacks
  and the alarm do not renew it.
- A finished agent turn also renews it, so a user gets a full lease to read an answer.
- The alarm checks the lease after its other work. While agent work is outstanding (a running
  turn, or a recorded call to a callable agent) the lease never expires; the window restarts.
- On expiry the Overseer tells each live client interface and each open still in progress, flushes
  storage and aborts. The front Worker closes the socket with close code 4001 once no workspace
  open remains on that session; the browser parks (stage 2) rather than redialling.
- Calls arriving after the decision is committed fail with `WorkspaceSessionExpiredError`; the
  client reconnects. The abort happens in the same continuation as the flush, so no write follows it.
- A KV key `.sessionLease` with value `off` in the `BLUEPRINTS` namespace disables enforcement
  (checks are skipped and re-armed). A KV read failure leaves it enforced.

## What expiry costs

An abort is a Durable Object restart, which the platform and this codebase already survive
(deploys, access restarts). State is durable. In-flight work not tracked as agent work, such as a
gatekeeper callback or hook delivery executing during the 5-second notification window, is cut
short and retried by its own mechanism. A paused user pays one click to resume; nothing is lost.

## Billing

Duration is billed while the object is resident. Without the lease a retained dead session keeps it
resident indefinitely; with it, residency after the last browser activity is bounded by 10 minutes
plus the alarm latency. Savings are therefore proportional to the number of workspaces left open by
a gone client. To measure: compare `overseer.session.lease.expired` log counts (`durationMs` is the
idle time at expiry) with the Durable Object duration metric for the Overseer namespace before and
after enabling, using the kill switch for the baseline.
