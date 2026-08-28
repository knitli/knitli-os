/**
 * Start best-effort cross-DO revocation cleanup and synchronously arm capability invalidation
 * before waiting for either remote operation. Callers may then await cleanup for reporting without
 * letting a slow User or Gatekeeper DO keep already-issued workspace capabilities alive.
 */
export async function runRevocationCleanup({
  tearDownObservers,
  refreshListings,
  scheduleRestart,
}: {
  tearDownObservers: () => Promise<void>;
  refreshListings: () => Promise<void>;
  scheduleRestart: () => void;
}): Promise<void> {
  const cleanup = Promise.all([tearDownObservers(), refreshListings()]);
  scheduleRestart();
  await cleanup;
}
