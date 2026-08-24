export type GatekeeperInitializationRecord = Readonly<{
  id: number;
  initializing?: true;
}>;

export type GatekeeperInitializationStorage = {
  gatekeepers: {
    list(): Iterable<GatekeeperInitializationRecord>;
    delete(id: number): void;
  };
};

export type GatekeeperInitializationFacets = {
  delete(name: string): void;
};

/**
 * Discard Gatekeeper records whose asynchronous describe step was interrupted by a DO restart.
 * The iterable is materialized before deletion so storage-backed iterators never remain live while
 * their collection is mutated.
 */
export function discardInterruptedGatekeeperInitializations(
  storage: GatekeeperInitializationStorage,
  facets: GatekeeperInitializationFacets,
): void {
  for (let record of Array.from(storage.gatekeepers.list())) {
    if (!record.initializing) continue;
    facets.delete(`gatekeeper${record.id}`);
    storage.gatekeepers.delete(record.id);
  }
}
