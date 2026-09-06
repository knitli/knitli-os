import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { matchesResourceUrlPattern } from "@gadgets/workshop-shared/gatekeeper";
import type {
  BoundIdentity,
  DraftReference,
  HostDraftAuthority,
  OpenApiBoundAccount,
} from "@gadgets/workshop-shared/fork/openapi-host-binding";
import {
  BindingError,
  createHostBindingLedger,
  type BindingRow,
  type BindingStore,
} from "./openapi-binding-ledger";

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

/** Private account capabilities and draft lifecycle, bound to one authenticated User DO. */
export function createOpenApiUserBinding(context: OpenApiUserBindingContext) {
  const ledger = createHostBindingLedger(context.store, context.now);
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
  function scope(
    row: BindingRow,
    accountId: number,
    incarnation: string,
    workspaceId: string,
    requireLive = true,
  ) {
    current(accountId, incarnation);
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
    scope(row, identity.providerAccountId, identity.accountIncarnation, identity.workspaceId);
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
          row.accountIncarnation === epoch!.incarnation);
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
        await context.revokeRecipient(record, recipient.workspaceId, recipient.drafts);
        context.transaction(() => {
          const fresh = context.cleanup.get(record.incarnation);
          if (!fresh) return;
          const acknowledged = fresh.recipients.find(item => item.workspaceId === recipient.workspaceId);
          if (!acknowledged) return;
          for (const reference of acknowledged.drafts) ledger.finishRevocation(reference.draftId);
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
  return {
    ledger,
    drainCleanup,
    snapshot,
    assertUnchanged,
    /** Fence before provider work, then conditionally commit only that exact lifecycle operation. */
    async mutateAccount(accountId: number, operation: () => Promise<void>, commit: () => void) {
      const expected = fence(accountId);
      await operation();
      await drainCleanup(accountId);
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
      const { epoch } = current(accountId);
      const authorityId = crypto.randomUUID();
      const authority = new (class extends RpcTarget implements HostDraftAuthority {
        async registerDraft(reference: DraftReference) {
          return context.transaction(() => {
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
        }
        async cancelDraft(draftId: string) {
          if (context.getDraftIssuer(draftId) !== authorityId) fail("DRAFT_NOT_FOUND");
          const row = context.store.get(draftId) ?? fail("DRAFT_NOT_FOUND");
          scope(row, accountId, epoch.incarnation, workspaceId, false);
          ledger.cancel(draftId);
        }
      })();
      const account = record.account as Fetcher<GatekeeperUser & OpenApiBoundAccount>;
      const frame = await account.startBoundResourceConfigurator(
        pattern,
        authority as RpcStub<HostDraftAuthority>,
      );
      try {
        current(accountId, epoch.incarnation);
      } catch (error) {
        frame.ui?.[Symbol.dispose]();
        throw error;
      }
      return frame;
    },
    async lookup(accountId: number, url: string, workspaceId: string) {
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
      scope(row, accountId, epoch.incarnation, workspaceId);
      const resolved = await (
        account.account as Fetcher<GatekeeperUser & OpenApiBoundAccount>
      ).resolveBoundDraft(structuredClone(row.reference));
      try {
        scope(
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
        scope(fresh, accountId, epoch.incarnation, workspaceId);
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
    /** Resolve only the stored immutable draft through its exact current or retired account. */
    async resolveForRevocation(requested: BindingRow) {
      const row = context.store.get(requested.reference.draftId) ?? fail("DRAFT_NOT_FOUND");
      if (row.ownerId !== context.ownerId || requested.ownerId !== row.ownerId ||
          requested.providerAccountId !== row.providerAccountId ||
          requested.accountIncarnation !== row.accountIncarnation ||
          requested.intendedWorkspaceId !== row.intendedWorkspaceId ||
          requested.reference.grantId !== row.reference.grantId ||
          requested.reference.selectionDigest !== row.reference.selectionDigest)
        fail("BINDING_IDENTITY_MISMATCH");
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
