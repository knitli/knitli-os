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
- The lease arms only once the caller is the owner or an authorized collaborator; a denied `open()`
  never renews it. An open parked before that point (a collaborator in a share-key redemption or
  observer dialog) is ended by the lease only if a prior owner or collaborator call armed it.
- Calls arriving after the decision is committed fail with `WorkspaceSessionExpiredError`; the
  client reconnects. The abort happens in the same continuation as the flush, so no write follows it.
- The lease is **opt-in**: it enforces only while the KV key `.sessionLease` in the `BLUEPRINTS`
  namespace holds `on`. Absent, any other value, or a failed KV read means disabled (checks are
  skipped and re-armed). It ends sessions with a close code only the idle-pause UI understands, so
  enable it once that UI is deployed; flipping the key needs no deploy. A workspace picks the
  change up at its next lease check: immediately for a freshly woken one, but up to one lease (10
  minutes) later for one already resident, since a disabled check re-arms a full lease out and the
  KV read (cached 60 seconds) only happens when the alarm runs.
- The reap runs even when another alarm concern fails; the failure is rethrown afterwards so the
  platform still retries it.

## Known limitation

A client that disposes the workspace interface but keeps capabilities it minted (gadget,
gatekeeper, facet, subscription) keeps renewing the lease through them, and the session's open has
already been released by the interface's disposal. If those later go idle, the Overseer ends
itself but the socket is not closed with the idle code, so the browser finds its retained
capabilities broken instead of parking. The shipped client disposes the interface only on
navigation, which drops what it minted too.

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
