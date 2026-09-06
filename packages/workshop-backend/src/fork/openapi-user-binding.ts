import { RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { matchesResourceUrlPattern } from "@gadgets/workshop-shared/gatekeeper";
import type {
  BoundIdentity,
  DraftReference,
  HostDraftAuthority,
  OpenApiBoundAccount,
  OpenApiRevocationFinalizer,
} from "@gadgets/workshop-shared/fork/openapi-host-binding";
import {
  BindingError,
  createHostBindingLedger,
  type BindingRow,
  type BindingStore,
} from "./openapi-binding-ledger";

/** The RPC surface contains only the two authenticated draft operations. */
@validateRpc()
class HostDraftAuthorityTarget extends RpcTarget implements HostDraftAuthority {
  #register: (reference: DraftReference) => { expiresAt: number };
  #cancel: (draftId: string) => void;

  constructor(register: (reference: DraftReference) => { expiresAt: number }, cancel: (draftId: string) => void) {
    super();
    this.#register = register;
    this.#cancel = cancel;
  }

  async registerDraft(reference: DraftReference): Promise<{ expiresAt: number }> {
    return this.#register(reference);
  }

  async cancelDraft(draftId: string): Promise<void> {
    this.#cancel(draftId);
  }
}

/** An acknowledged receipt grants cleanup proof only, never activation authority. */
@validateRpc()
class AcknowledgedRevocationFinalizer extends RpcTarget implements OpenApiRevocationFinalizer {
  #assertAcknowledged: () => void;

  constructor(assertAcknowledged: () => void) {
    super();
    this.#assertAcknowledged = assertAcknowledged;
  }

  async revoke(_reason: "removed" | "account-disconnected" | "creation-failed"): Promise<void> {
    this.#assertAcknowledged();
  }
}

/** Durable account incarnation; a fenced incarnation is never revived. */
export type OpenApiAccountEpoch = { id: number; incarnation: string; live: boolean };
/** Retired account capability retained only until every exact recipient acknowledges cleanup. */
export type OpenApiAccountCleanup = {
  incarnation: string;
  ownerId: string;
  providerAccountId: number;
  account: Fetcher<GatekeeperUser>;
  recipients: { workspaceId: string; drafts: DraftReference[] }[];
};
/** Durable proof that the connector acknowledged cleanup for this exact immutable scope. */
export type OpenApiDraftCleanupReceipt = Pick<BindingRow,
  "ownerId" | "providerAccountId" | "accountIncarnation" | "intendedWorkspaceId" | "reference">;
/** Permanent issuance fence plus the exact registered drafts captured before workspace deletion. */
export type OpenApiWorkspaceRetirement = {
  workspaceId: string;
  ownerId: string;
  drafts: OpenApiDraftCleanupReceipt[];
};
/** Narrow adapter over User-owned synchronous durable storage and account policy. */
export interface OpenApiUserBindingContext {
  transaction<T>(operation: () => T): T;
  ownerId: string;
  publicBaseUrl?: string;
  store: BindingStore & { list(): BindingRow[] };
  getAccount(
    id: number,
  ):
    | { account: Fetcher<GatekeeperUser>; description: AccountDescription; vendorId: string }
    | undefined;
  getDraftIssuer(draftId: string): string | undefined;
  putDraftIssuer(draftId: string, authorityId: string): void;
  cleanup: {
    get(incarnation: string): OpenApiAccountCleanup | undefined;
    put(record: OpenApiAccountCleanup): void;
    delete(incarnation: string): void;
    list(): OpenApiAccountCleanup[];
  };
  receipts: {
    get(draftId: string): OpenApiDraftCleanupReceipt | undefined;
    put(receipt: OpenApiDraftCleanupReceipt): void;
  };
  retirements: {
    get(workspaceId: string): OpenApiWorkspaceRetirement | undefined;
    put(retirement: OpenApiWorkspaceRetirement): void;
    list(): OpenApiWorkspaceRetirement[];
  };
  scheduleCleanup(): void;
  revokeRecipient(record: OpenApiAccountCleanup, workspaceId: string, drafts: DraftReference[]): Promise<void>;
  getEpoch(id: number): OpenApiAccountEpoch | undefined;
  putEpoch(epoch: OpenApiAccountEpoch): void;
  checkPolicy(
    vendorId: string,
    resource: Awaited<ReturnType<OpenApiBoundAccount["resolveBoundDraft"]>>["resource"],
  ): Promise<void>;
  now(): number;
}
const fail = (code: string): never => {
  throw new BindingError(code);
};

function sameScope(a: OpenApiDraftCleanupReceipt, b: OpenApiDraftCleanupReceipt) {
  return a.ownerId === b.ownerId && a.providerAccountId === b.providerAccountId &&
    a.accountIncarnation === b.accountIncarnation &&
    a.intendedWorkspaceId === b.intendedWorkspaceId &&
    a.reference.draftId === b.reference.draftId && a.reference.grantId === b.reference.grantId &&
    a.reference.selectionDigest === b.reference.selectionDigest;
}

function cleanupScope(row: BindingRow): OpenApiDraftCleanupReceipt {
  return {ownerId: row.ownerId, providerAccountId: row.providerAccountId,
    accountIncarnation: row.accountIncarnation, intendedWorkspaceId: row.intendedWorkspaceId,
    reference: structuredClone(row.reference)};
}

/** Private account capabilities and draft lifecycle, bound to one authenticated User DO. */
export function createOpenApiUserBinding(context: OpenApiUserBindingContext) {
  const ledger = createHostBindingLedger(context.store, context.now);
  function assertWorkspaceOpen(workspaceId: string) {
    if (context.retirements.get(workspaceId)) fail("BINDING_WORKSPACE_CLOSED");
  }
  function acknowledged(scope: OpenApiDraftCleanupReceipt) {
    const receipt = context.receipts.get(scope.reference.draftId);
    return Boolean(receipt && sameScope(receipt, scope));
  }
  function recordAcknowledgement(scope: OpenApiDraftCleanupReceipt) {
    const row = context.store.get(scope.reference.draftId) ?? fail("DRAFT_NOT_FOUND");
    if (!sameScope(scope, row)) fail("BINDING_IDENTITY_MISMATCH");
    ledger.finishRevocation(scope.reference.draftId);
    context.receipts.put(structuredClone(scope));
  }
  function current(accountId: number, expected?: string) {
    const account = context.getAccount(accountId);
    if (!account || account.description.hostBindingProtocol !== "openapi-v1")
      return fail("BINDING_ACCOUNT_UNAVAILABLE");
    let epoch = context.getEpoch(accountId);
    if (!epoch) {
      epoch = { id: accountId, incarnation: crypto.randomUUID(), live: true };
      context.putEpoch(epoch);
    }
    if (!epoch.live || (expected !== undefined && expected !== epoch.incarnation))
      return fail("BINDING_ACCOUNT_REPLACED");
    return { account, epoch };
  }
  function checkScope(
    row: BindingRow,
    accountId: number,
    incarnation: string,
    workspaceId: string,
    requireLive = true,
  ) {
    current(accountId, incarnation);
    assertWorkspaceOpen(workspaceId);
    if (
      row.ownerId !== context.ownerId ||
      row.providerAccountId !== accountId ||
      row.accountIncarnation !== incarnation ||
      row.intendedWorkspaceId !== workspaceId
    )
      fail("BINDING_IDENTITY_MISMATCH");
    if (!requireLive) return;
    if (row.state === "revoking" || row.state === "revoked") fail("BINDING_REVOKED");
    if (row.state !== "active" && context.now() >= row.expiresAt) fail("DRAFT_EXPIRED");
  }
  function canonical(url: string) {
    if (!context.publicBaseUrl) return fail("BINDING_ORIGIN_UNCONFIGURED");
    const parsed = new URL(url);
    const origin = new URL(context.publicBaseUrl).origin;
    const parts = parsed.pathname.split("/");
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.href !== url ||
      parts.length !== 9 ||
      parts[1] !== "gatekeeper" ||
      parts[2] !== "openapi" ||
      parts[3] !== "apis" ||
      parts[5] !== "releases" ||
      parts[7] !== "grants"
    )
      return fail("BINDING_INVALID_LOCATOR");
    const decoded = [4, 6, 8].map((index) => {
      let value: string;
      try {
        value = decodeURIComponent(parts[index]);
      } catch {
        return fail("BINDING_INVALID_LOCATOR");
      }
      if (
        !value.trim() ||
        new TextEncoder().encode(value).length > 256 ||
        value === "." ||
        value === ".." ||
        /[\\/]/.test(value) ||
        encodeURIComponent(value) !== parts[index]
      )
        return fail("BINDING_INVALID_LOCATOR");
      return value;
    });
    return decoded[2];
  }
  function checked(identity: BoundIdentity) {
    const row = context.store.get(identity.draftId) ?? fail("DRAFT_NOT_FOUND");
    checkScope(row, identity.providerAccountId, identity.accountIncarnation, identity.workspaceId);
    if (identity.ownerId !== context.ownerId) fail("BINDING_IDENTITY_MISMATCH");
    return row;
  }
  function snapshot(accountId: number) {
    if (context.getEpoch(accountId)) return context.getEpoch(accountId)!.incarnation;
    if (context.getAccount(accountId)?.description.hostBindingProtocol === "openapi-v1")
      return current(accountId).epoch.incarnation;
    return undefined;
  }
  function assertUnchanged(accountId: number, expected: string | undefined) {
    if (expected !== undefined && context.getEpoch(accountId)?.incarnation !== expected)
      fail("BINDING_ACCOUNT_REPLACED");
  }
  function fence(accountId: number) {
    return context.transaction(() => {
      const record = context.getAccount(accountId);
      let epoch = context.getEpoch(accountId);
      if (!epoch && record?.description.hostBindingProtocol === "openapi-v1")
        epoch = current(accountId).epoch;
      if (!epoch) return undefined;
      if (epoch.live && record) {
        const rows = context.store.list().filter(row =>
          row.ownerId === context.ownerId && row.providerAccountId === accountId &&
          row.accountIncarnation === epoch!.incarnation && !acknowledged(row));
        if (rows.length) {
          const recipients = new Map<string, DraftReference[]>();
          for (const row of rows) {
            const drafts = recipients.get(row.intendedWorkspaceId) ?? [];
            drafts.push(structuredClone(row.reference));
            recipients.set(row.intendedWorkspaceId, drafts);
            ledger.beginRevocation(row.reference.draftId);
          }
          context.cleanup.put({
            incarnation: epoch.incarnation, ownerId: context.ownerId,
            providerAccountId: accountId, account: record.account,
            recipients: Array.from(recipients, ([workspaceId, drafts]) => ({workspaceId, drafts})),
          });
          context.scheduleCleanup();
        }
      }
      const incarnation = crypto.randomUUID();
      context.putEpoch({ id: accountId, incarnation, live: false });
      return incarnation;
    });
  }
  async function drainCleanup(accountId?: number) {
    const pending = context.cleanup.list().filter(record =>
      accountId === undefined || record.providerAccountId === accountId);
    const results = await Promise.allSettled(pending.flatMap(record =>
      record.recipients.map(async recipient => {
        const scope = (reference: DraftReference): OpenApiDraftCleanupReceipt => ({
          ownerId: record.ownerId, providerAccountId: record.providerAccountId,
          accountIncarnation: record.incarnation, intendedWorkspaceId: recipient.workspaceId, reference,
        });
        const pendingDrafts = recipient.drafts.filter(reference => !acknowledged(scope(reference)));
        if (pendingDrafts.length)
          await context.revokeRecipient(record, recipient.workspaceId, pendingDrafts);
        context.transaction(() => {
          const fresh = context.cleanup.get(record.incarnation);
          if (!fresh) return;
          const recipientRecord = fresh.recipients.find(item => item.workspaceId === recipient.workspaceId);
          if (!recipientRecord) return;
          for (const reference of recipientRecord.drafts) recordAcknowledgement(scope(reference));
          fresh.recipients = fresh.recipients.filter(item => item.workspaceId !== recipient.workspaceId);
          if (fresh.recipients.length) context.cleanup.put(fresh);
          else context.cleanup.delete(record.incarnation);
        });
      })));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") {
      context.scheduleCleanup();
      throw failure.reason;
    }
  }
  async function resolveForRevocation(requested: OpenApiDraftCleanupReceipt) {
    const row = context.store.get(requested.reference.draftId) ?? fail("DRAFT_NOT_FOUND");
    if (row.ownerId !== context.ownerId || requested.ownerId !== row.ownerId ||
        requested.providerAccountId !== row.providerAccountId ||
        requested.accountIncarnation !== row.accountIncarnation ||
        requested.intendedWorkspaceId !== row.intendedWorkspaceId ||
        requested.reference.grantId !== row.reference.grantId ||
        requested.reference.selectionDigest !== row.reference.selectionDigest)
      fail("BINDING_IDENTITY_MISMATCH");
    if (acknowledged(row)) {
      const receipt = cleanupScope(row);
      // Exact durable connector acknowledgement can outlive both the account capability and
      // the workspace. This proof-only revoker cannot activate, resolve a class, or dispatch.
      return {finalizer: new RpcStub(new AcknowledgedRevocationFinalizer(() => {
        if (!acknowledged(receipt)) fail("BINDING_CLEANUP_NOT_ACKNOWLEDGED");
      }))};
    }
    const retired = context.cleanup.get(row.accountIncarnation);
    let account: Fetcher<GatekeeperUser>;
    if (retired) {
      if (retired.ownerId !== row.ownerId || retired.providerAccountId !== row.providerAccountId ||
          !retired.recipients.some(recipient => recipient.workspaceId === row.intendedWorkspaceId &&
            recipient.drafts.some(ref => ref.draftId === row.reference.draftId &&
              ref.grantId === row.reference.grantId && ref.selectionDigest === row.reference.selectionDigest)))
        return fail("BINDING_IDENTITY_MISMATCH");
      account = retired.account;
    } else {
      account = current(row.providerAccountId, row.accountIncarnation).account.account;
    }
    const finalizer = await (account as Fetcher<GatekeeperUser & OpenApiBoundAccount>)
      .resolveBoundDraftForRevocation(structuredClone(row.reference));
    return { finalizer };
  }
  function hasPendingRetirements() {
    return context.retirements.list().some(retirement => retirement.drafts.some(scope => !acknowledged(scope)));
  }
  async function drainWorkspaceRetirement(workspaceId: string) {
    const retirement = context.retirements.get(workspaceId) ?? fail("BINDING_WORKSPACE_NOT_CLOSED");
    if (retirement.ownerId !== context.ownerId || retirement.workspaceId !== workspaceId)
      fail("BINDING_IDENTITY_MISMATCH");
    const results = await Promise.allSettled(retirement.drafts.map(async scope => {
      if (scope.ownerId !== context.ownerId || scope.intendedWorkspaceId !== workspaceId)
        fail("BINDING_IDENTITY_MISMATCH");
      if (acknowledged(scope)) return;
      try {
        using finalizer = (await resolveForRevocation(scope)).finalizer;
        await finalizer.revoke("removed");
        context.transaction(() => recordAcknowledgement(scope));
      } catch (error) {
        // Concurrent account fanout may have already recorded the exact acknowledgement and
        // released its historical account capability while this cleanup resolver was suspended.
        if (!acknowledged(scope)) throw error;
      }
    }));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") {
      context.scheduleCleanup();
      throw failure.reason;
    }
  }
  async function drainWorkspaceRetirements() {
    const results = await Promise.allSettled(context.retirements.list()
      .filter(retirement => retirement.drafts.some(scope => !acknowledged(scope)))
      .map(retirement => drainWorkspaceRetirement(retirement.workspaceId)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  return {
    ledger,
    resolveForRevocation,
    hasPendingRetirements,
    drainWorkspaceRetirements,
    /** Permanently stop issuance before awaiting the exact connector cleanup acknowledgements. */
    async retireWorkspace(workspaceId: string) {
      context.transaction(() => {
        if (context.retirements.get(workspaceId)) return;
        const rows = context.store.list().filter(row =>
          row.ownerId === context.ownerId && row.intendedWorkspaceId === workspaceId);
        context.retirements.put({workspaceId, ownerId: context.ownerId, drafts: rows.map(cleanupScope)});
        for (const row of rows) ledger.beginRevocation(row.reference.draftId);
        if (rows.some(row => !acknowledged(row))) context.scheduleCleanup();
      });
      await drainWorkspaceRetirement(workspaceId);
    },
    drainCleanup,
    snapshot,
    assertUnchanged,
    /**
     * Deliver recipient fences and finish connector cleanup before provider work.
     * A failed recipient leaves durable retry work and the provider operation uninvoked;
     * remote fencing takes effect on receipt, not atomically with the User-side fence.
     * Commit only if this exact lifecycle operation still owns the account epoch.
     */
    async mutateAccount(accountId: number, operation: () => Promise<void>, commit: () => void) {
      const expected = fence(accountId);
      await drainCleanup(accountId);
      await operation();
      context.transaction(() => {
        assertUnchanged(accountId, expected);
        commit();
      });
    },
    /** Permanently fence before any provider RPC; rows retain cleanup recipients. */
    fence,
    /** A newly installed account gets a distinct durable incarnation. */
    replace(accountId: number) {
      if (context.getEpoch(accountId))
        context.putEpoch({ id: accountId, incarnation: crypto.randomUUID(), live: true });
    },
    async start(accountId: number, pattern: string, workspaceId?: string) {
      const record = context.getAccount(accountId) ?? fail("BINDING_ACCOUNT_UNAVAILABLE");
      if (record.description.hostBindingProtocol !== "openapi-v1")
        return record.account.startResourceConfigurator(pattern);
      if (!workspaceId) return fail("WORKSPACE_CONTEXT_REQUIRED");
      assertWorkspaceOpen(workspaceId);
      const { epoch } = current(accountId);
      const authorityId = crypto.randomUUID();
      const authority = new HostDraftAuthorityTarget(
        (reference) => {
          return context.transaction(() => {
            assertWorkspaceOpen(workspaceId);
            current(accountId, epoch.incarnation);
            const issuer = context.getDraftIssuer(reference.draftId);
            if (
              (issuer !== undefined || context.store.get(reference.draftId)) &&
              issuer !== authorityId
            )
              fail("DRAFT_CONFLICT");
            // A grant locator may identify only one immutable draft in this scope.
            for (const row of context.store.list()) {
              if (
                row.ownerId === context.ownerId &&
                row.providerAccountId === accountId &&
                row.accountIncarnation === epoch.incarnation &&
                row.reference.grantId === reference.grantId &&
                row.reference.draftId !== reference.draftId
              )
                fail("DRAFT_CONFLICT");
            }
            const row = ledger.register({
              reference: structuredClone(reference),
              ownerId: context.ownerId,
              providerAccountId: accountId,
              accountIncarnation: epoch.incarnation,
              intendedWorkspaceId: workspaceId,
              expiresAt: context.now() + 900_000,
              state: "draft",
              keyEpoch: 0,
            });
            context.putDraftIssuer(row.reference.draftId, authorityId);
            return { expiresAt: row.expiresAt };
          });
        },
        (draftId) => {
          if (context.getDraftIssuer(draftId) !== authorityId) fail("DRAFT_NOT_FOUND");
          const row = context.store.get(draftId) ?? fail("DRAFT_NOT_FOUND");
          checkScope(row, accountId, epoch.incarnation, workspaceId, false);
          ledger.cancel(draftId);
        },
      );
      const account = record.account as Fetcher<GatekeeperUser & OpenApiBoundAccount>;
      using authorityStub = new RpcStub(authority);
      const frame = await account.startBoundResourceConfigurator(pattern, authorityStub);
      try {
        current(accountId, epoch.incarnation);
        assertWorkspaceOpen(workspaceId);
      } catch (error) {
        frame.ui?.[Symbol.dispose]();
        throw error;
      }
      return frame;
    },
    async lookup(accountId: number, url: string, workspaceId: string) {
      assertWorkspaceOpen(workspaceId);
      const grantId = canonical(url);
      const { account, epoch } = current(accountId);
      const matches = context.store
        .list()
        .filter(
          (row) =>
            row.ownerId === context.ownerId &&
            row.providerAccountId === accountId &&
            row.accountIncarnation === epoch.incarnation &&
            row.intendedWorkspaceId === workspaceId &&
            row.reference.grantId === grantId,
        );
      if (matches.length !== 1) return fail("DRAFT_NOT_FOUND");
      const row = matches[0];
      checkScope(row, accountId, epoch.incarnation, workspaceId);
      const resolved = await (
        account.account as Fetcher<GatekeeperUser & OpenApiBoundAccount>
      ).resolveBoundDraft(structuredClone(row.reference));
      try {
        checkScope(
          context.store.get(row.reference.draftId) ?? fail("DRAFT_NOT_FOUND"),
          accountId,
          epoch.incarnation,
          workspaceId,
        );
        if (
          resolved.resourceUrl !== url ||
          !matchesResourceUrlPattern(resolved.resource.urlPattern, url)
        )
          fail("BINDING_RESOURCE_URL_MISMATCH");
        await context.checkPolicy(account.vendorId, resolved.resource);
        const fresh = context.store.get(row.reference.draftId) ?? fail("DRAFT_NOT_FOUND");
        checkScope(fresh, accountId, epoch.incarnation, workspaceId);
        return {
          ...resolved,
          row: fresh,
          vendorId: account.vendorId,
          typeUrlPattern: resolved.resource.urlPattern,
        };
      } catch (error) {
        resolved.finalizer[Symbol.dispose]();
        throw error;
      }
    },
    reserve(identity: BoundIdentity) {
      checked(identity);
      return ledger.reserve(identity);
    },
    beginActivation(identity: BoundIdentity) {
      checked(identity);
      ledger.beginActivation(identity);
    },
    activate(identity: BoundIdentity, digest: string) {
      checked(identity);
      ledger.activate(identity, digest);
    },
    assertReady(identity: BoundIdentity) {
      const row = checked(identity);
      if (
        !row.identity ||
        Object.keys(row.identity).some(
          (key) =>
            row.identity![key as keyof BoundIdentity] !== identity[key as keyof BoundIdentity],
        )
      )
        fail("BINDING_IDENTITY_MISMATCH");
    },
  };
}
