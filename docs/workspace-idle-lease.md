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

A gatekeeper session the browser retains (`openSession()`), and capabilities such as cursors that
its calls return, are called directly on the gatekeeper and never pass through the Overseer, so they
do not renew the lease. Proxying them through the Overseer would renew it but changes their failure
semantics: calls then die with the Overseer's access restarts instead of completing (it broke the
`sensitive-observations` integration test, whose read must resolve before the 100 ms restart). The
shipped client's visible-tab heartbeat renews the lease every 30 seconds while the page is alive,
which covers a user working through such a session; a page that cannot run does no such work.

## What expiry costs

An abort is a Durable Object restart, which the platform and this codebase already survive
(deploys, access restarts). State is durable. In-flight work not tracked as agent work, such as a
gatekeeper callback or hook delivery executing during the 5-second notification window, is cut
short and retried by its own mechanism. A collaborator `open()` suspended in the observer dialog when expiry commits can still persist the
observer record the user just confirmed before failing with `WorkspaceSessionExpiredError`; that is
the user's own authorized choice and is idempotent, so their next open finds it already done. A paused user pays one click to resume; nothing is lost.

## Billing

Duration is billed while the object is resident. Without the lease a retained dead session keeps it
resident indefinitely; with it, residency after the last browser activity is bounded by 10 minutes
plus the alarm latency. Savings are therefore proportional to the number of workspaces left open by
a gone client. To measure: compare `overseer.session.lease.expired` log counts (`durationMs` is the
idle time at expiry) with the Durable Object duration metric for the Overseer namespace before and
after enabling, using the kill switch for the baseline.

## Client

- `useWorkspaceIdle` (mounted by `GadgetEditor`) pauses the connection after 5 minutes hidden or 10
  minutes visible without input (pointer, key, touch, wheel, scroll; mouse movement does not count).
  Input inside the sandboxed gadget iframe is forwarded to the parent as an `activity` message, at
  most one per 10 seconds. No pause while the selected chat is streaming.
- A pause (or a `4001` close from the server) drops the socket and parks `main.tsx`'s reconnect
  loop; nothing dials until a deliberate request: sending from the composer, approving or denying
  an action or connection request, the "Paused — click to reconnect" chip, or leaving the
  workspace. Calls made while paused queue on the placeholder stub and flush on resume, so chat
  history, the composer draft and the gadget iframe survive.
- An unanswered observer-config dialog does not defer a pause: the dialog is cancelled and the tab
  parks on the chip; resuming re-opens the workspace, which asks again.
- The 30-second workspace heartbeat skips while paused, since it is itself a client call that
  would queue and, on resume, renew the lease.
- A visible tab's heartbeat renews the lease every 30 seconds, so the server lease expires only for
  sessions whose page can no longer run (frozen, killed, offline); a live idle tab pauses itself.
