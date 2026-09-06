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
    const epoch = context.getEpoch(accountId);
    if (epoch || context.getAccount(accountId)?.description.hostBindingProtocol === "openapi-v1") {
      const incarnation = crypto.randomUUID();
      context.putEpoch({ id: accountId, incarnation, live: false });
      return incarnation;
    }
    return undefined;
  }
  return {
    ledger,
    snapshot,
    assertUnchanged,
    /** Fence before provider work, then conditionally commit only that exact lifecycle operation. */
    async mutateAccount(accountId: number, operation: () => Promise<void>, commit: () => void) {
      const expected = fence(accountId);
      await operation();
      assertUnchanged(accountId, expected);
      context.transaction(commit);
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
