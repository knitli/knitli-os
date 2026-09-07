import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { AccountDescription, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import type { OpenApiConnectAuthority, OpenApiConnectCompletion, OpenApiConnectIdentity, OpenApiConnectReceipt, OpenApiConnectionNotifications } from "@gadgets/workshop-shared/fork/openapi-connect";
import type { OpenApiAccountEpoch } from "./openapi-user-binding";

/** User-owned pending attempt, including the expected canonical receipt for reconnect. */
export type OpenApiConnectAttempt = {
  id: string; vendorId: string; accountId: number; incarnation: string; expiresAt: number;
  expected?: OpenApiCanonicalConnection;
  committed?: OpenApiCanonicalConnection;
};
/** Immutable completion indexed by the vendor-scoped provider-verified profile/principal tuple. */
export type OpenApiCanonicalConnection = {
  key: string; attemptId: string; vendorId: string; accountId: number; incarnation: string;
  profileId: string; principalId: string; receiptDigest: string; destinationCommitment: string;
  connectionGeneration: number;
};
/** Existing User connected-account storage; never call the generic replacement callback. */
export type OpenApiConnectedAccount = {
  id: number; vendorId: string; account: Fetcher<GatekeeperUser>; description: AccountDescription;
  credentialExpiresAt?: Date; credentialsExpired?: boolean;
};
/** Synchronous durable adapters keep canonical completion and account incarnation atomic. */
export type OpenApiConnectContext = {
  ownerId: string; now(): number; transaction<T>(operation: () => T): T;
  attempts: { get(id: string): OpenApiConnectAttempt | undefined; put(row: OpenApiConnectAttempt): void;
    list(): Iterable<OpenApiConnectAttempt>; delete(id: string): void };
  canonical: { get(key: string): OpenApiCanonicalConnection | undefined; put(row: OpenApiCanonicalConnection): void };
  accounts: { get(id: number): OpenApiConnectedAccount | undefined; put(row: OpenApiConnectedAccount): void };
  epochs: { get(id: number): OpenApiAccountEpoch | undefined; put(row: OpenApiAccountEpoch): void };
  reserveAccountId(): number;
  checkVendor(vendorId: string): Promise<void>;
  fenceAccount(id: number): void;
  drainCleanup(id: number): Promise<void>;
  authority(attempt: OpenApiConnectAttempt): Fetcher<OpenApiConnectAuthority>;
  notifications(row: OpenApiCanonicalConnection): Fetcher<OpenApiConnectionNotifications>;
};
const fail = (): never => { throw new Error("OPENAPI_CONNECT_UNAVAILABLE"); };
const same = (a: OpenApiCanonicalConnection, b: OpenApiCanonicalConnection) =>
  a.key === b.key && a.attemptId === b.attemptId && a.vendorId === b.vendorId &&
  a.accountId === b.accountId && a.incarnation === b.incarnation && a.receiptDigest === b.receiptDigest &&
  a.destinationCommitment === b.destinationCommitment && a.connectionGeneration === b.connectionGeneration;

/** Private connect lifecycle for one authenticated User DO. */
export function createOpenApiConnect(context: OpenApiConnectContext) {
  function isCurrent(row: OpenApiCanonicalConnection) {
    const canonical = context.canonical.get(row.key);
    const epoch = context.epochs.get(row.accountId);
    const account = context.accounts.get(row.accountId);
    if (!canonical || !same(canonical, row) || !epoch?.live || epoch.incarnation !== row.incarnation ||
        account?.vendorId !== row.vendorId || account.description.hostBindingProtocol !== "openapi-v1") return false;
    return true;
  }
  function current(row: OpenApiCanonicalConnection) {
    if (!isCurrent(row)) fail();
    return context.accounts.get(row.accountId) ?? fail();
  }
  function active(id: string, vendorId: string) {
    const attempt = context.attempts.get(id);
    if (!attempt || attempt.vendorId !== vendorId) return fail();
    if (attempt.committed) current(attempt.committed);
    else {
      if (context.now() >= attempt.expiresAt) fail();
      if (attempt.expected) current(attempt.expected);
    }
    return attempt;
  }
  async function admitted(id: string, vendorId: string) {
    active(id, vendorId);
    await context.checkVendor(vendorId);
    return active(id, vendorId);
  }
  function begin(vendorId: string, expected?: OpenApiCanonicalConnection) {
    return context.transaction(() => {
      if (expected) current(expected);
      // Reap only authority that already fails active(). Current committed receipts
      // outlive initiation TTL; unexpired initial attempts remain usable.
      let reconnectReserved = false;
      for (const pending of context.attempts.list()) {
        const stale = pending.committed ? !isCurrent(pending.committed) :
          context.now() >= pending.expiresAt || (pending.expected !== undefined && !isCurrent(pending.expected));
        if (stale) context.attempts.delete(pending.id);
        else if (expected && !pending.committed && pending.expected && same(pending.expected, expected)) reconnectReserved = true;
      }
      // Reserve one host reconnect before any provider credential work. The Account
      // independently CASes its credential generation during the later handoff.
      if (reconnectReserved) fail();
      const attempt: OpenApiConnectAttempt = {
        id: crypto.randomUUID(), vendorId, accountId: expected?.accountId ?? context.reserveAccountId(),
        incarnation: crypto.randomUUID(), expiresAt: context.now() + 10 * 60_000, expected,
      };
      context.attempts.put(attempt);
      return context.authority(attempt);
    });
  }
  function immutable(request: OpenApiConnectCompletion, row: OpenApiCanonicalConnection) {
    if (request.profileId !== row.profileId || request.principalId !== row.principalId ||
        request.receiptDigest !== row.receiptDigest || request.destinationCommitment !== row.destinationCommitment) fail();
  }
  function receipt(row: OpenApiCanonicalConnection): OpenApiConnectReceipt {
    current(row);
    return { providerAccountId: row.accountId, accountIncarnation: row.incarnation,
      connectionGeneration: row.connectionGeneration, notifications: context.notifications(row) };
  }
  return {
    begin,
    async identity(id: string, vendorId: string): Promise<OpenApiConnectIdentity> {
      const attempt = await admitted(id, vendorId);
      return {ownerId: context.ownerId, vendorId, connectAttemptId: id,
        expectedConnectionGeneration: attempt.expected?.connectionGeneration};
    },
    async assertActive(id: string, vendorId: string) { await admitted(id, vendorId); },
    async reconnect(id: string, vendorId: string, expectedConnectionGeneration: number) {
      const attempt = await admitted(id, vendorId);
      const row = attempt.committed ?? fail();
      if (!Number.isSafeInteger(expectedConnectionGeneration) || row.connectionGeneration !== expectedConnectionGeneration) fail();
      return begin(vendorId, row);
    },
    async complete(id: string, vendorId: string, request: OpenApiConnectCompletion) {
      // Generated RPC validation checks field types, but intentionally permits extra keys.
      if (Object.keys(request).some(key => !["profileId", "principalId", "account", "receiptDigest", "destinationCommitment"].includes(key))) fail();
      for (const value of [request.profileId, request.principalId, request.destinationCommitment]) {
        if (!value.trim() || new TextEncoder().encode(value).length > 256) fail();
      }
      if (!/^[a-f0-9]{64}$/.test(request.receiptDigest)) fail();
      let attempt = await admitted(id, vendorId);
      if (attempt.committed) {
        immutable(request, attempt.committed);
        // A retry's supplied Account is deliberately never invoked, stored, or revoked.
        await context.drainCleanup(attempt.accountId);
        await admitted(id, vendorId);
        return receipt(attempt.committed);
      }
      const key = JSON.stringify([vendorId, request.profileId, request.principalId]);
      if (attempt.expected && (key !== attempt.expected.key || request.destinationCommitment !== attempt.expected.destinationCommitment)) fail();
      const account = attempt.expected ? current(attempt.expected).account : request.account;
      const description = await account.describe();
      if (description.hostBindingProtocol !== "openapi-v1") fail();
      await admitted(id, vendorId);
      const row = context.transaction(() => {
        attempt = active(id, vendorId);
        // Concurrent exact completions may both have crossed describe(); only one commits.
        if (attempt.committed) { immutable(request, attempt.committed); return attempt.committed; }
        const previous = context.canonical.get(key);
        if (attempt.expected) {
          if (!previous || !same(previous, attempt.expected)) fail();
          current(attempt.expected);
          context.fenceAccount(attempt.accountId);
        } else if (previous) {
          const epoch = context.epochs.get(previous.accountId);
          if (epoch?.live && epoch.incarnation === previous.incarnation && context.accounts.get(previous.accountId)) fail();
        }
        const committed: OpenApiCanonicalConnection = {
          key, attemptId: id, vendorId, accountId: attempt.accountId, incarnation: attempt.incarnation,
          profileId: request.profileId, principalId: request.principalId, receiptDigest: request.receiptDigest,
          destinationCommitment: request.destinationCommitment,
          connectionGeneration: (attempt.expected?.connectionGeneration ?? 0) + 1,
        };
        context.accounts.put({id: attempt.accountId, vendorId, account, description, credentialsExpired: false});
        context.epochs.put({id: attempt.accountId, incarnation: attempt.incarnation, live: true});
        context.canonical.put(committed);
        context.attempts.put({...attempt, committed});
        return committed;
      });
      await context.drainCleanup(row.accountId);
      await admitted(id, vendorId);
      return receipt(row);
    },
    async notify(row: OpenApiCanonicalConnection, expired: boolean, expiresAt?: Date) {
      let account = current(row);
      if (expired) {
        context.transaction(() => { account = current(row); context.accounts.put({...account, credentialsExpired: true}); });
      } else {
        const description = await account.account.describe();
        context.transaction(() => {
          account = current(row);
          if (description.hostBindingProtocol !== "openapi-v1") fail();
          context.accounts.put({...account, description, credentialsExpired: false, credentialExpiresAt: expiresAt});
        });
      }
    },
  };
}

/** Persistable admission scope carried exclusively in host-created entrypoint props. */
export type OpenApiConnectAuthorityProps = { userId: string; attemptId: string; vendorId: string };
/** Host-minted private authority; the caller cannot supply a User identity in an RPC argument. */
@validateRpc()
export class OpenApiConnectAuthorityImpl extends WorkerEntrypoint<Cloudflare.Env, OpenApiConnectAuthorityProps> implements OpenApiConnectAuthority {
  #user() { return this.ctx.exports.UserDurableObject.get(this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId)); }
  async getIdentity(): ReturnType<OpenApiConnectAuthority["getIdentity"]> { return this.#user().openApiConnectIdentity(this.ctx.props.attemptId, this.ctx.props.vendorId); }
  async assertActive(): ReturnType<OpenApiConnectAuthority["assertActive"]> { await this.#user().assertOpenApiConnectActive(this.ctx.props.attemptId, this.ctx.props.vendorId); }
  async complete(request: OpenApiConnectCompletion): ReturnType<OpenApiConnectAuthority["complete"]> { return this.#user().completeOpenApiConnect(this.ctx.props.attemptId, this.ctx.props.vendorId, request); }
  async beginReconnect(expectedConnectionGeneration: number): ReturnType<OpenApiConnectAuthority["beginReconnect"]> { return this.#user().beginOpenApiReconnect(this.ctx.props.attemptId, this.ctx.props.vendorId, expectedConnectionGeneration); }
}
/** Notifications are separate persistable entrypoints with no completion method. */
@validateRpc()
export class OpenApiConnectionNotificationsImpl extends WorkerEntrypoint<Cloudflare.Env, {userId: string; row: OpenApiCanonicalConnection}> implements OpenApiConnectionNotifications {
  #user() { return this.ctx.exports.UserDurableObject.get(this.ctx.exports.UserDurableObject.idFromString(this.ctx.props.userId)); }
  async credentialsExpired(): ReturnType<OpenApiConnectionNotifications["credentialsExpired"]> { await this.#user().notifyOpenApiCredentials(this.ctx.props.row, true); }
  async credentialsRestored(expiresAt?: Date): ReturnType<OpenApiConnectionNotifications["credentialsRestored"]> { await this.#user().notifyOpenApiCredentials(this.ctx.props.row, false, expiresAt); }
}
