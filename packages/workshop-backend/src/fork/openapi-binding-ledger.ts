import type {
  BoundIdentity,
  DraftReference,
} from "@gadgets/workshop-shared/fork/openapi-host-binding";

/** Durable, forward-only lifecycle phases. */
export type BindingState = "draft" | "reserved" | "activating" | "active" | "revoking" | "revoked";
/** Persisted authority state; revoked rows are permanent tombstones. */
export type BindingRow = {
  reference: DraftReference;
  ownerId: string;
  providerAccountId: number;
  accountIncarnation: string;
  intendedWorkspaceId: string;
  expiresAt: number;
  state: BindingState;
  identity?: BoundIdentity;
  keyEpoch: number;
  key?: { keyId: string; publicKeyDigest: string };
};
/** Synchronous durable storage supplied by the owning DO. */
export interface BindingStore {
  get(draftId: string): BindingRow | undefined;
  put(draftId: string, row: BindingRow): void;
}
/** Synchronous state transitions; callers separately fence account incarnation. */
export interface HostBindingLedger {
  register(row: BindingRow): BindingRow;
  reserve(identity: BoundIdentity): BindingRow;
  beginActivation(identity: BoundIdentity): void;
  activate(identity: BoundIdentity, selectionDigest: string): void;
  cancel(draftId: string): void;
  authorizeKey(identity: BoundIdentity, keyId: string, publicKeyDigest: string): number;
  revokeKey(
    identity: BoundIdentity,
    registration: { keyId: string; publicKeyDigest: string; keyEpoch: number },
  ): void;
  assertActive(identity: BoundIdentity, keyEpoch: number): void;
  beginRevocation(draftId: string): void;
  finishRevocation(draftId: string): void;
}
/** Stable, non-sensitive protocol error. */
export class BindingError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const fail = (code: string): never => {
  throw new BindingError(code);
};
const encoder = new TextEncoder();
function id(value: string) {
  if (typeof value !== "string" || !value.trim() || encoder.encode(value).length > 256)
    fail("BINDING_INVALID_INPUT");
}
function integer(value: number, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("BINDING_INVALID_INPUT");
}
function reference(value: DraftReference) {
  id(value.draftId);
  id(value.grantId);
  id(value.selectionDigest);
}
function identity(value: BoundIdentity) {
  reference(value);
  id(value.ownerId);
  id(value.accountIncarnation);
  id(value.workspaceId);
  id(value.facetName);
  integer(value.providerAccountId);
  integer(value.gatekeeperId);
  integer(value.generation);
  if (value.facetName !== `gatekeeper${value.gatekeeperId}`) fail("BINDING_IDENTITY_MISMATCH");
}
function sameReference(a: DraftReference, b: DraftReference) {
  return (
    a.draftId === b.draftId && a.grantId === b.grantId && a.selectionDigest === b.selectionDigest
  );
}
function sameIdentity(a: BoundIdentity, b: BoundIdentity) {
  return (
    sameReference(a, b) &&
    a.ownerId === b.ownerId &&
    a.providerAccountId === b.providerAccountId &&
    a.accountIncarnation === b.accountIncarnation &&
    a.workspaceId === b.workspaceId &&
    a.gatekeeperId === b.gatekeeperId &&
    a.facetName === b.facetName &&
    a.generation === b.generation
  );
}
/** Construct a ledger with injected synchronous persistence and clock. */
export function createHostBindingLedger(store: BindingStore, now: () => number): HostBindingLedger {
  const read = (draftId: string) => {
    id(draftId);
    const row = store.get(draftId);
    if (!row) return fail("DRAFT_NOT_FOUND");
    return structuredClone(row);
  };
  const put = (row: BindingRow) => {
    store.put(row.reference.draftId, structuredClone(row));
    return structuredClone(row);
  };
  const live = (row: BindingRow) => {
    if (row.state === "revoking" || row.state === "revoked") fail("BINDING_REVOKED");
    // Draft TTL limits creation/finalization, not the lifetime of an activated connection.
    if (row.state !== "active" && now() >= row.expiresAt) fail("DRAFT_EXPIRED");
  };
  const checked = (value: BoundIdentity, requireLive = true) => {
    identity(value);
    const row = read(value.draftId);
    if (
      !sameReference(row.reference, value) ||
      row.ownerId !== value.ownerId ||
      row.providerAccountId !== value.providerAccountId ||
      row.accountIncarnation !== value.accountIncarnation ||
      row.intendedWorkspaceId !== value.workspaceId ||
      (row.identity && !sameIdentity(row.identity, value))
    ) {
      fail("BINDING_IDENTITY_MISMATCH");
    }
    if (requireLive) live(row);
    return row;
  };
  const active = (value: BoundIdentity) => {
    const row = checked(value);
    if (row.state !== "active") fail("BINDING_NOT_ACTIVE");
    return row;
  };
  return {
    register(row) {
      reference(row.reference);
      id(row.ownerId);
      id(row.accountIncarnation);
      id(row.intendedWorkspaceId);
      integer(row.providerAccountId);
      integer(row.expiresAt, 0);
      if (row.state !== "draft" || row.identity || row.key || row.keyEpoch !== 0)
        fail("BINDING_INVALID_INPUT");
      const existing = store.get(row.reference.draftId);
      if (existing) {
        if (
          !sameReference(existing.reference, row.reference) ||
          existing.ownerId !== row.ownerId ||
          existing.providerAccountId !== row.providerAccountId ||
          existing.accountIncarnation !== row.accountIncarnation ||
          existing.intendedWorkspaceId !== row.intendedWorkspaceId
        )
          fail("DRAFT_CONFLICT");
        live(existing);
        return structuredClone(existing);
      }
      if (row.expiresAt <= now() || row.expiresAt > now() + 900_000) fail("DRAFT_EXPIRED");
      return put(row);
    },
    reserve(value) {
      identity(value);
      const existing = read(value.draftId);
      if (
        existing.identity &&
        !sameIdentity(existing.identity, value) &&
        sameReference(existing.reference, value) &&
        existing.ownerId === value.ownerId &&
        existing.providerAccountId === value.providerAccountId &&
        existing.accountIncarnation === value.accountIncarnation &&
        existing.intendedWorkspaceId === value.workspaceId
      )
        fail("DRAFT_ALREADY_RESERVED");
      const row = checked(value);
      if (row.state === "draft") {
        row.identity = structuredClone(value);
        row.state = "reserved";
        return put(row);
      }
      return row;
    },
    beginActivation(value) {
      const row = checked(value);
      if (row.state === "activating" || row.state === "active") return;
      if (row.state !== "reserved") fail("BINDING_NOT_RESERVED");
      row.state = "activating";
      put(row);
    },
    activate(value, selectionDigest) {
      id(selectionDigest);
      const row = checked(value);
      if (selectionDigest !== row.reference.selectionDigest) fail("BINDING_IDENTITY_MISMATCH");
      if (row.state === "active") return;
      if (row.state !== "activating") fail("BINDING_NOT_ACTIVATING");
      row.state = "active";
      put(row);
    },
    cancel(draftId) {
      const row = read(draftId);
      if (row.state === "revoked") return;
      if (row.state !== "draft") fail("DRAFT_ALREADY_RESERVED");
      row.state = "revoked";
      row.keyEpoch++;
      put(row);
    },
    authorizeKey(value, keyId, publicKeyDigest) {
      id(keyId);
      id(publicKeyDigest);
      const row = active(value);
      if (row.key) {
        if (row.key.keyId !== keyId || row.key.publicKeyDigest !== publicKeyDigest)
          fail("DISPATCH_KEY_CONFLICT");
        return row.keyEpoch;
      }
      integer(row.keyEpoch + 1);
      row.keyEpoch++;
      row.key = { keyId, publicKeyDigest };
      put(row);
      return row.keyEpoch;
    },
    revokeKey(value, registration) {
      id(registration.keyId);
      id(registration.publicKeyDigest);
      integer(registration.keyEpoch);
      const row = checked(value, false);
      if (registration.keyEpoch < row.keyEpoch) return;
      live(row);
      if (
        registration.keyEpoch !== row.keyEpoch ||
        !row.key ||
        row.key.keyId !== registration.keyId ||
        row.key.publicKeyDigest !== registration.publicKeyDigest
      )
        fail("DISPATCH_KEY_CONFLICT");
      integer(row.keyEpoch + 1);
      row.keyEpoch++;
      delete row.key;
      put(row);
    },
    assertActive(value, keyEpoch) {
      integer(keyEpoch);
      const row = active(value);
      if (!row.key || row.keyEpoch !== keyEpoch) fail("DISPATCH_KEY_REVOKED");
    },
    beginRevocation(draftId) {
      const row = read(draftId);
      if (row.state === "revoking" || row.state === "revoked") return;
      integer(row.keyEpoch + 1);
      row.state = "revoking";
      row.keyEpoch++;
      delete row.key;
      put(row);
    },
    finishRevocation(draftId) {
      const row = read(draftId);
      if (row.state === "revoked") return;
      if (row.state !== "revoking") fail("BINDING_NOT_REVOKING");
      row.state = "revoked";
      put(row);
    },
  };
}
