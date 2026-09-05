import { describe, expect, it } from "vitest";
import type { BoundIdentity } from "@gadgets/workshop-shared/fork/openapi-host-binding";
import {
  BindingError,
  createHostBindingLedger,
  type BindingRow,
} from "../src/fork/openapi-binding-ledger";

function fixture() {
  let clock = 1_000;
  const rows = new Map<string, BindingRow>();
  const store = {
    get: (id: string) => {
      const row = rows.get(id);
      return row && structuredClone(row);
    },
    put: (id: string, row: BindingRow) => {
      rows.set(id, structuredClone(row));
    },
  };
  const restart = () => createHostBindingLedger(store, () => clock);
  const ledger = restart();
  const identity: BoundIdentity = {
    draftId: "draft-1",
    grantId: "grant-1",
    selectionDigest: "selection-1",
    ownerId: "owner-1",
    providerAccountId: 7,
    accountIncarnation: "account-v1",
    workspaceId: "workspace-1",
    gatekeeperId: 12,
    facetName: "gatekeeper12",
    generation: 1,
  };
  const draft: BindingRow = {
    reference: {
      draftId: identity.draftId,
      grantId: identity.grantId,
      selectionDigest: identity.selectionDigest,
    },
    ownerId: identity.ownerId,
    providerAccountId: identity.providerAccountId,
    accountIncarnation: identity.accountIncarnation,
    intendedWorkspaceId: identity.workspaceId,
    expiresAt: clock + 900_000,
    state: "draft",
    keyEpoch: 0,
  };
  ledger.register(draft);
  const activate = () => {
    ledger.reserve(identity);
    ledger.beginActivation(identity);
    ledger.activate(identity, identity.selectionDigest);
  };
  return {
    ledger,
    identity,
    draft,
    store,
    restart,
    activate,
    expire: () => {
      clock += 900_000;
    },
  };
}
function rejects(action: () => unknown, code: string) {
  expect(action).toThrow(BindingError);
  expect(action).toThrow(code);
}

describe("authenticated host reservation", () => {
  it("returns original expiry for exact registration retries and prevents mutable aliases", () => {
    const { ledger, draft, store } = fixture();
    const result = ledger.register({ ...draft, expiresAt: draft.expiresAt - 1 });
    expect(result.expiresAt).toBe(draft.expiresAt);
    result.reference.grantId = "changed";
    expect(store.get(draft.reference.draftId)?.reference.grantId).toBe("grant-1");
  });
  it.each(["ownerId", "accountIncarnation", "intendedWorkspaceId"] as const)(
    "rejects registration changes to %s",
    (field) => {
      const { ledger, draft } = fixture();
      rejects(() => ledger.register({ ...draft, [field]: "changed" }), "DRAFT_CONFLICT");
    },
  );
  it("rejects changed reference or account on registration", () => {
    const { ledger, draft } = fixture();
    rejects(
      () =>
        ledger.register({
          ...draft,
          reference: { ...draft.reference, selectionDigest: "changed" },
        }),
      "DRAFT_CONFLICT",
    );
    rejects(() => ledger.register({ ...draft, providerAccountId: 8 }), "DRAFT_CONFLICT");
  });
  it.each(["ownerId", "accountIncarnation", "workspaceId", "grantId", "selectionDigest"] as const)(
    "rejects substituted %s before any reservation",
    (field) => {
      const { ledger, identity } = fixture();
      rejects(() => ledger.reserve({ ...identity, [field]: "other" }), "BINDING_IDENTITY_MISMATCH");
      expect(ledger.reserve(identity).state).toBe("reserved");
    },
  );
  it("rejects wrong account and unregistered draft", () => {
    const { ledger, identity } = fixture();
    rejects(
      () => ledger.reserve({ ...identity, providerAccountId: 8 }),
      "BINDING_IDENTITY_MISMATCH",
    );
    rejects(() => ledger.reserve({ ...identity, draftId: "fabricated" }), "DRAFT_NOT_FOUND");
  });
  it("never lets a different facet redeem a reserved draft first", () => {
    const { ledger, identity } = fixture();
    ledger.reserve(identity);
    rejects(
      () => ledger.beginActivation({ ...identity, gatekeeperId: 13, facetName: "gatekeeper13" }),
      "BINDING_IDENTITY_MISMATCH",
    );
    rejects(
      () => ledger.reserve({ ...identity, gatekeeperId: 13, facetName: "gatekeeper13" }),
      "DRAFT_ALREADY_RESERVED",
    );
    ledger.beginActivation(identity);
    ledger.activate(identity, identity.selectionDigest);
    expect(ledger.reserve(identity).identity).toEqual(identity);
  });
  it("rejects generation substitution at activation and dispatch", () => {
    const { ledger, identity, activate } = fixture();
    activate();
    const epoch = ledger.authorizeKey(identity, "key", "digest");
    rejects(
      () => ledger.beginActivation({ ...identity, generation: 2 }),
      "BINDING_IDENTITY_MISMATCH",
    );
    rejects(
      () => ledger.assertActive({ ...identity, generation: 2 }, epoch),
      "BINDING_IDENTITY_MISMATCH",
    );
  });
  it("requires the persisted phase and original selection before activation", () => {
    const { ledger, identity } = fixture();
    rejects(() => ledger.beginActivation(identity), "BINDING_NOT_RESERVED");
    ledger.reserve(identity);
    rejects(() => ledger.activate(identity, identity.selectionDigest), "BINDING_NOT_ACTIVATING");
    ledger.beginActivation(identity);
    rejects(() => ledger.activate(identity, "substitution"), "BINDING_IDENTITY_MISMATCH");
    rejects(() => ledger.authorizeKey(identity, "key", "digest"), "BINDING_NOT_ACTIVE");
  });
  it.each(["draft", "reserved", "activating"] as const)(
    "enforces TTL at %s independently of cleanup",
    (phase) => {
      const { ledger, identity, expire } = fixture();
      if (phase !== "draft") ledger.reserve(identity);
      if (phase === "activating") ledger.beginActivation(identity);
      expire();
      rejects(() => ledger.reserve(identity), "DRAFT_EXPIRED");
      rejects(() => ledger.beginActivation(identity), "DRAFT_EXPIRED");
      rejects(() => ledger.activate(identity, identity.selectionDigest), "DRAFT_EXPIRED");
    },
  );
  it("does not expire an activated connection when its original draft TTL elapses", () => {
    const { ledger, identity, activate, expire } = fixture();
    activate();
    const epoch = ledger.authorizeKey(identity, "key", "digest");
    expire();
    ledger.assertActive(identity, epoch);
  });
  it("retains canceled tombstones and never releases reservations", () => {
    const a = fixture();
    a.ledger.cancel(a.identity.draftId);
    a.ledger.cancel(a.identity.draftId);
    rejects(() => a.ledger.reserve(a.identity), "BINDING_REVOKED");
    rejects(() => a.ledger.register(a.draft), "BINDING_REVOKED");
    const b = fixture();
    b.ledger.reserve(b.identity);
    rejects(() => b.ledger.cancel(b.identity.draftId), "DRAFT_ALREADY_RESERVED");
  });
  it("recovers every durable phase with exact retries after restart", () => {
    const { identity, draft, restart } = fixture();
    expect(restart().register(draft).state).toBe("draft");
    restart().reserve(identity);
    expect(restart().reserve(identity).state).toBe("reserved");
    restart().beginActivation(identity);
    restart().beginActivation(identity);
    restart().activate(identity, identity.selectionDigest);
    restart().activate(identity, identity.selectionDigest);
    expect(restart().reserve(identity).state).toBe("active");
    restart().beginRevocation(identity.draftId);
    restart().beginRevocation(identity.draftId);
    restart().finishRevocation(identity.draftId);
    restart().finishRevocation(identity.draftId);
    rejects(() => restart().reserve(identity), "BINDING_REVOKED");
  });
  it("uses exact key retries, checks all revoke fields, and fences ABA successors", () => {
    const { ledger, identity, activate } = fixture();
    activate();
    const first = ledger.authorizeKey(identity, "key", "digest");
    expect(ledger.authorizeKey(identity, "key", "digest")).toBe(first);
    rejects(() => ledger.authorizeKey(identity, "key2", "digest"), "DISPATCH_KEY_CONFLICT");
    rejects(() => ledger.authorizeKey(identity, "key", "digest2"), "DISPATCH_KEY_CONFLICT");
    rejects(
      () =>
        ledger.revokeKey(identity, { keyId: "other", publicKeyDigest: "digest", keyEpoch: first }),
      "DISPATCH_KEY_CONFLICT",
    );
    rejects(
      () => ledger.revokeKey(identity, { keyId: "key", publicKeyDigest: "other", keyEpoch: first }),
      "DISPATCH_KEY_CONFLICT",
    );
    ledger.revokeKey(identity, { keyId: "key", publicKeyDigest: "digest", keyEpoch: first });
    rejects(() => ledger.assertActive(identity, first), "DISPATCH_KEY_REVOKED");
    const second = ledger.authorizeKey(identity, "key", "digest");
    expect(second).toBeGreaterThan(first);
    ledger.revokeKey(identity, { keyId: "key", publicKeyDigest: "digest", keyEpoch: first });
    ledger.assertActive(identity, second);
    rejects(() => ledger.assertActive(identity, first), "DISPATCH_KEY_REVOKED");
  });
  it("fences dispatch immediately and increments revocation epoch exactly once", () => {
    const { ledger, identity, activate, store } = fixture();
    activate();
    const epoch = ledger.authorizeKey(identity, "key", "digest");
    rejects(() => ledger.finishRevocation(identity.draftId), "BINDING_NOT_REVOKING");
    ledger.beginRevocation(identity.draftId);
    ledger.beginRevocation(identity.draftId);
    expect(store.get(identity.draftId)?.keyEpoch).toBe(epoch + 1);
    rejects(() => ledger.assertActive(identity, epoch), "BINDING_REVOKED");
    rejects(() => ledger.activate(identity, identity.selectionDigest), "BINDING_REVOKED");
    ledger.finishRevocation(identity.draftId);
    expect(store.get(identity.draftId)?.state).toBe("revoked");
  });
  it.each(["", " ", "é".repeat(129)])(
    "rejects empty or oversized UTF-8 identities (%s)",
    (invalid) => {
      const { ledger, identity } = fixture();
      rejects(() => ledger.reserve({ ...identity, ownerId: invalid }), "BINDING_INVALID_INPUT");
    },
  );
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric identities (%s)",
    (invalid) => {
      const { ledger, identity } = fixture();
      rejects(() => ledger.reserve({ ...identity, generation: invalid }), "BINDING_INVALID_INPUT");
    },
  );
});

it("acknowledges retired-key cleanup after the host revocation fence", () => {
  const { ledger, identity, activate } = fixture();
  activate();
  const keyEpoch = ledger.authorizeKey(identity, "key", "digest");
  const registration = { keyId: "key", publicKeyDigest: "digest", keyEpoch };
  ledger.beginRevocation(identity.draftId);
  ledger.revokeKey(identity, registration);
  rejects(() => ledger.revokeKey({ ...identity, generation: 2 }, registration), "BINDING_IDENTITY_MISMATCH");
  rejects(() => ledger.authorizeKey(identity, "key", "digest"), "BINDING_REVOKED");
  rejects(() => ledger.assertActive(identity, keyEpoch), "BINDING_REVOKED");
  ledger.finishRevocation(identity.draftId);
  ledger.revokeKey(identity, registration);
});
