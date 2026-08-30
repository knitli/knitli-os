/**
 * Start best-effort cross-DO revocation cleanup and synchronously arm capability invalidation.
 *
 * Both calls are dispatched while the input gate is still open, then `scheduleRestart()` closes it
 * so no call arriving through an already-issued broad capability can run before the abort.
 *
 * Their replies are deliberately not awaited. A reply from the User or Gatekeeper DO is an input to
 * this one, so with the gate shut it cannot land -- awaiting it would block until the restart's
 * abort fires and take the caller's own `removeCollaborator()`/`revokeShareLink()` down with it,
 * rejecting a revocation that in fact succeeded. Both operations are best-effort by construction
 * (see `tearDownLostObservers()`), and the abort discards whatever has not finished regardless, so
 * there is nothing here worth waiting for. Rejections are swallowed for the same reason.
 */
export function runRevocationCleanup({
  tearDownObservers,
  refreshListings,
  scheduleRestart,
}: {
  tearDownObservers: () => Promise<void>;
  refreshListings: () => Promise<void>;
  scheduleRestart: () => void;
}): void {
  void Promise.all([tearDownObservers(), refreshListings()]).catch(() => undefined);
  scheduleRestart();
}
