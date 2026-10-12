/**
 * Escrow for credentials a reconnect / ensureResources flow obtained but the Workshop has not yet
 * confirmed came from the account's owner (see `GatekeeperUser.reconnect` in workshop-shared).
 *
 * A reconnect URL is a Bearer [REDACTED], and gadgets bound to the account read its live credentials
 * straight from the gatekeeper, so a flow that wrote its result live would hand those gadgets a
 * phished victim's tokens with nothing in the way. Instead the flow stages them here and reports
 * `reconnectComplete()`; only `GatekeeperUser.commitReconnect()`, called once the Workshop has
 * verified the completing browser, moves them to the live keys. No read path serves a stage and no
 * other write activates one: an uncommitted stage sits until committed, expired past use, or
 * dropped outright by `discardStagedCredentials`.
 *
 * Every stage carries a random `stageId`, which the flow passes to `reconnectComplete()` so the
 * Workshop's ticket names the exact credentials whose completion minted it. Two reconnects can
 * overlap — the owner's and one a phished victim finished — and a commit that took "whatever is
 * staged" would let the ticket from the first activate the second's credentials. Stages are
 * therefore stored by id and commits name one: overlapping flows coexist, and each ticket can only
 * ever activate its own stage's credentials.
 */

import { generateNonce, OAUTH_NONCE_LIFETIME_MS } from "./connect-nonce";
import type { KvMutable } from "./kv";

/**
 * KV key that held the one staged record before stages were stored by id. Records found here are
 * migrated to their own key on read, so a reconnect in flight across the upgrade still commits.
 */
export const STAGED_CREDENTIALS_KEY = "stagedCredentials";

/** KV key holding the stage index: stage ids in the order they were staged. */
const STAGE_INDEX_KEY = "stagedCredentials:index";

/** KV key holding one stage's record. */
const stageKey = (stageId: string) => `${STAGED_CREDENTIALS_KEY}:${stageId}`;

/** The stored record: the consumer's credentials, plus the stage's own id and expiry. */
type StagedCredentials<T> = { creds: T; stageId: string; expiresAt: number };

/** A stage's credentials together with the id a commit must name to take them. */
export type StagedCredentialsView<T> = { creds: T; stageId: string };

/**
 * Stages credentials for a later `commitStagedCredentials`. Stages coexist by id: starting a flow
 * never invalidates a handoff another flow already issued. A caller that can safely dispose the
 * previous live stage must `peekStagedCredentials` immediately before this call, with no await
 * between them, then dispose it after this call.
 * @param kv Durable Object storage.
 * @param creds Whatever the connector needs to write its live keys on commit.
 * @param now Current Unix time in milliseconds.
 * @param ttlMs How long the stage stays committable; the Workshop redeems well within the default.
 * @returns The new stage's id, to pass to `GatekeeperConnectCallback.reconnectComplete()`.
 *
 * @example
 * ```ts
 * const stageId = stageCredentials(this.ctx.storage.kv, { accessToken, scopes }, Date.now());
 * return callback.reconnectComplete(stageId);
 * ```
 */
export function stageCredentials<T>(
  kv: KvMutable,
  creds: T,
  now: number,
  ttlMs: number = OAUTH_NONCE_LIFETIME_MS,
): string {
  const stageId = generateNonce();
  const ids = loadStages(kv);
  kv.put<StagedCredentials<T>>(stageKey(stageId), { creds, stageId, expiresAt: now + ttlMs });
  kv.put<string[]>(STAGE_INDEX_KEY, [...ids, stageId]);
  return stageId;
}

/** Whether a stored value is a stage record at all, regardless of expiry. */
function isStageRecord(value: unknown): value is StagedCredentials<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.stageId === "string" && Number.isFinite(record.expiresAt)
      && record.creds !== undefined;
}

/**
 * Loads the index, migrating and pruning it. A record left at the legacy single key moves to its
 * own key so it still commits; index entries whose record is missing or misshapen drop out.
 * Expired records stay: their own flow can still dispose of them, and a commit deletes the one it
 * was handed on sight.
 * @param kv Durable Object storage.
 * @returns The ids with a readable record, oldest first.
 */
function loadStages(kv: KvMutable): string[] {
  const legacy = kv.get<unknown>(STAGED_CREDENTIALS_KEY);
  if (isStageRecord(legacy)) {
    kv.put(stageKey(legacy.stageId), legacy);
  }
  if (legacy !== undefined) kv.delete(STAGED_CREDENTIALS_KEY);
  const index = kv.get<unknown>(STAGE_INDEX_KEY);
  const ids = (Array.isArray(index) ? index : []).filter((id): id is string =>
      typeof id === "string");
  if (isStageRecord(legacy) && !ids.includes(legacy.stageId)) ids.push(legacy.stageId);
  const pruned = ids.filter(id => isStageRecord(kv.get(stageKey(id))));
  if (pruned.length > 0 || index !== undefined) kv.put<string[]>(STAGE_INDEX_KEY, pruned);
  return pruned;
}

/**
 * Reads one stage's record, deleting a value no caller could use — null, not an object, or
 * missing a field — so every public reader can keep its `T | null` contract.
 * @param kv Durable Object storage.
 * @param stageId The stage to read.
 * @returns The stage's record, or `undefined` when there is none.
 */
function storedStage<T>(kv: KvMutable, stageId: string): StagedCredentials<T> | undefined {
  const staged = kv.get<StagedCredentials<T>>(stageKey(stageId));
  if (staged === undefined) return undefined;
  if (typeof staged?.stageId === "string" && Number.isFinite(staged.expiresAt)
      && staged.creds !== undefined) return staged;
  kv.delete(stageKey(stageId));
  return undefined;
}

/** Deletes a stage's record and its index entry. */
function dropStage(kv: KvMutable, stageId: string): void {
  kv.delete(stageKey(stageId));
  const index = kv.get<unknown>(STAGE_INDEX_KEY);
  if (Array.isArray(index)) {
    kv.put<string[]>(STAGE_INDEX_KEY, index.filter((id): id is string =>
        typeof id === "string" && id !== stageId));
  }
}

/**
 * Reads the newest stage that is still committable. A non-finite clock reads as expired, so an
 * unusable time source cannot activate a stage.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @returns The newest live stage, or `null` when none is committable.
 */
export function peekStagedCredentials<T>(kv: KvMutable, now: number): StagedCredentialsView<T> | null {
  const ids = loadStages(kv);
  if (!Number.isFinite(now)) return null;
  for (let i = ids.length - 1; i >= 0; i--) {
    const staged = storedStage<T>(kv, ids[i]);
    if (staged !== undefined && now < staged.expiresAt) {
      return { creds: staged.creds, stageId: staged.stageId };
    }
  }
  return null;
}

/**
 * Takes the staged credentials, if the stage named by `stageId` is still live. A matching stage
 * is deleted, so a commit happens at most once; an expired or unusable stage is deleted too
 * rather than left for a later caller. Any other stage is left in place: it belongs to another
 * flow, whose own ticket is the only thing that may commit it.
 * @param kv Durable Object storage.
 * @param now Current Unix time in milliseconds.
 * @param stageId The id `stageCredentials` returned for the stage being committed.
 * @returns The staged credentials, or `null` when that stage is not live.
 *
 * @example
 * ```ts
 * const staged = commitStagedCredentials<Grant>(this.ctx.storage.kv, Date.now(), stageId);
 * if (!staged) throw new Error("Nothing to commit.");
 * this.ctx.storage.kv.put("accessToken", staged.accessToken);
 * ```
 */
export function commitStagedCredentials<T>(kv: KvMutable, now: number, stageId: string): T | null {
  loadStages(kv);
  const staged = storedStage<T>(kv, stageId);
  if (staged === undefined) return null;
  // Plain comparison: the id is an identity, not a secret. Only the Workshop can reach
  // `commitReconnect`, and it names the id its own record carries.
  if (!Number.isFinite(now) || now >= staged.expiresAt) {
    dropStage(kv, stageId);
    return null;
  }
  dropStage(kv, stageId);
  return staged.creds;
}

/**
 * Drops stages and returns what they held, for gatekeeper-owned disposal. Given no `stageId` it
 * drops every live stage and returns the newest one's credentials; given one it drops only that
 * exact stage, so another flow's stage survives a cleanup this flow scheduled. A record no caller
 * could use is dropped, reporting `null`.
 *
 * Unlike a commit this ignores the stage TTL, which is what lets an abandoned stage be cleaned up
 * long after its window closed — and why the credentials it returns must never be written live.
 * Nothing has confirmed who obtained them, and `commitStagedCredentials` is the only path that may
 * activate a stage. The local deletion must happen before awaiting provider cleanup.
 * @param kv Durable Object storage.
 * @param stageId The exact stage to drop, for a caller that retained the id `stageCredentials` gave it.
 * @returns The dropped credentials, or `null` when nothing matched.
 */
export function discardStagedCredentials<T>(kv: KvMutable, stageId?: string): T | null {
  const ids = loadStages(kv);
  if (stageId !== undefined) {
    const staged = storedStage<T>(kv, stageId);
    if (staged === undefined) return null;
    dropStage(kv, stageId);
    return staged.creds;
  }
  let dropped: T | null = null;
  for (const id of ids) {
    const staged = storedStage<T>(kv, id);
    dropStage(kv, id);
    if (staged !== undefined) dropped = staged.creds;
  }
  return dropped;
}
