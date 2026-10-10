// Fork: the client-activity lease that bounds how long a workspace's Overseer stays resident when
// no browser is using it (ported from twinprime19/cloudflare-os, "bound idle residency with a
// client-activity lease" and its follow-ups; see docs/workspace-idle-lease.md).
//
// A browser that dies without closing its socket leaves the front Worker holding the capabilities
// open() returned, and holding them keeps the Overseer billing for hours at zero traffic: no event
// ever runs in that Worker's context again, so only the Overseer's own alarm can notice. The lease
// is renewed by every call a browser makes (and never by the agent, hooks or the alarm), and the
// alarm ends the incarnation once a full lease passes with no renewal and no agent work.
import { createWorkshopLogger } from "../observability";

const logger = createWorkshopLogger("workshop.idle-lease");

/** How long a workspace stays resident with nothing arriving from a browser. */
export const SESSION_LEASE_MS = 10 * 60_000;

/**
 * Reserved key in the BLUEPRINTS KV namespace switching the lease off (value `off`); any other
 * value, or no key, leaves it on. Flippable without a deploy.
 */
export const SESSION_LEASE_KEY = ".sessionLease";

const SESSION_LEASE_OFF = "off";

// A notification that never lands costs the client one reconnect (the socket closes without the
// idle code and the browser redials), which beats a workspace nothing can end.
const NOTIFY_TIMEOUT_MS = 5_000;

const ABORT_REASON = "idle session lease expired";

/** Raised to the front Worker's session when a workspace ended it for idleness. */
export class IdleSessionError extends Error {
  constructor(gadgetId: string) {
    super(`idle session lease expired (gadget ${gadgetId})`);
    this.name = "IdleSessionError";
  }
}

/** Refused by every client capability once expiry is committed: no write may follow the flush. */
export class WorkspaceSessionExpiredError extends Error {
  constructor() {
    super("This workspace session expired because nobody was using it. Reconnect to continue.");
    this.name = "WorkspaceSessionExpiredError";
  }
}

/** Lease state for one Overseer incarnation. Pure bookkeeping; the clock is injectable. */
export class IdleLease {
  // When a browser last reached this incarnation. Undefined until the first such call, which arms
  // the lease. Deliberately not a count of retained capabilities: one missed from a count is one
  // workspace nothing ends.
  #lastClientAt?: number;
  // When the last agent turn ended, so a user gets a full lease to read a finished answer.
  #lastWorkEndedAt?: number;
  // When a check last left the workspace alone despite an expired deadline, so the window restarts
  // from that decision. A check that merely arrived early leaves it untouched.
  #lastCheckAt?: number;
  #committed = false;
  #notifiers = new Set<() => Promise<void>>();

  constructor(private now: () => number = Date.now) {}

  /**
   * Renew the lease for a browser call. Throws once expiry is committed, so no call is accepted
   * only to be thrown away by the abort. Returns true for the first touch of the incarnation,
   * which is when the caller must (re)compute the alarm: later touches only move the deadline in
   * memory, and the alarm that fires early finds the lease renewed and re-arms.
   */
  touch(): boolean {
    if (this.#committed) throw new WorkspaceSessionExpiredError();
    let first = this.#lastClientAt === undefined;
    this.#lastClientAt = this.now();
    return first;
  }

  /** An agent turn ended: the user may read its answer without touching the server. */
  noteWorkEnded(): void {
    this.#lastWorkEndedAt = this.now();
  }

  /** When the alarm must next run for the lease, or undefined if it is unarmed or finished. */
  alarmTime(): number | undefined {
    return this.#lastClientAt === undefined || this.#committed ? undefined : this.#deadline();
  }

  /** Register a notification telling a front Worker session the workspace went idle. */
  addNotifier(notify: () => Promise<void>): Disposable {
    this.#notifiers.add(notify);
    return { [Symbol.dispose]: () => { this.#notifiers.delete(notify); } };
  }

  #deadline(): number {
    return Math.max(this.#lastClientAt ?? 0, this.#lastWorkEndedAt ?? 0, this.#lastCheckAt ?? 0)
        + SESSION_LEASE_MS;
  }

  /**
   * Decide, synchronously, whether to end the incarnation. "ended" commits the expiry. "none"
   * means unarmed; "deferred" means leave it alone and re-arm.
   */
  decide(hasAgentWork: boolean, switchedOff: boolean): "none" | "deferred" | "ended" {
    if (this.#committed || this.#lastClientAt === undefined) return "none";
    let now = this.now();
    if (switchedOff || hasAgentWork || now < this.#deadline()) {
      // Restart the window only when the deadline really has passed; moving it on an early check
      // would grant an unused workspace nearly a second lease, since the alarm is armed once.
      if (now >= this.#deadline()) this.#lastCheckAt = now;
      return "deferred";
    }
    this.#committed = true;
    return "ended";
  }

  /** How long since the last sign of life, for the log. */
  idleMs(): number {
    return this.now() - Math.max(
        this.#lastClientAt ?? 0, this.#lastWorkEndedAt ?? 0, this.#lastCheckAt ?? 0);
  }

  /** Tell every live client interface (and open in progress) the workspace went idle. */
  async notifyAll(): Promise<void> {
    if (this.#notifiers.size === 0) return;
    // Capped, not awaited to completion: the notification travels to a front Worker whose context
    // may never run an event again.
    await Promise.race([
      Promise.allSettled(Array.from(this.#notifiers, notify => notify())),
      scheduler.wait(NOTIFY_TIMEOUT_MS),
    ]);
  }
}

/** What the reap needs from its Overseer. */
export type LeaseHost = {
  lease: IdleLease;
  kv: KVNamespace;
  hasAgentWork(): boolean;
  /** Recompute the Overseer's single alarm. */
  rearm(): void;
  /** Flush storage and abort the incarnation. */
  flushAndAbort(reason: string): Promise<void>;
};

/**
 * End the incarnation if the lease has expired. Called by alarm() after every other alarm concern
 * has finished and re-armed, so an expiry never drops scheduled work. The decision is made in one
 * synchronous step after a single await (the kill switch): a client call renews the lease on
 * entry, so one younger than a lease is already inside the deadline, and a call landing after the
 * decision is refused rather than accepted and thrown away.
 */
export async function reapIdleSession(host: LeaseHost): Promise<void> {
  let { lease } = host;
  // A read failure leaves the lease enforced: KV is not the authority on whether anyone is here.
  let switchedOff = false;
  try {
    switchedOff = await host.kv.get(SESSION_LEASE_KEY, { cacheTtl: 60 }) === SESSION_LEASE_OFF;
  } catch (error) {
    logger.warn("failed to read the session lease switch", {
      event: "overseer.session.lease.switch.failed", error,
    });
  }

  let idleMs = lease.idleMs();
  let outcome = lease.decide(host.hasAgentWork(), switchedOff);
  if (outcome === "none") return;
  if (outcome === "deferred") {
    if (switchedOff) {
      logger.info("session lease check skipped by the kill switch", {
        event: "overseer.session.lease.skipped", durationMs: idleMs,
      });
    }
    host.rearm();
    return;
  }

  logger.info("session lease expired", { event: "overseer.session.lease.expired", durationMs: idleMs });
  // The lease is now excluded from the alarm; what remains is delivery and retention work, which
  // legitimately re-fires on the next incarnation.
  host.rearm();
  await lease.notifyAll();
  // Nothing may be awaited between the flush and the abort: the input gate keeps other events out
  // only while this continuation runs.
  await host.flushAndAbort(ABORT_REASON);
}

/** The key under which a browser-owned capability keeps its lease renewal. */
export const clientActivity = Symbol("clientActivity");

type ClientCallTarget = { [clientActivity]?: () => void };

/**
 * Mark `capability` as one a browser session owns, so its calls renew `renew` (the lease). A
 * symbol, not a name: these classes are RPC surfaces, and a symbol-keyed property is neither
 * callable by the client nor emitted by capnweb-validate's codegen. Provenance decides, never
 * class membership: the agent, hooks and binding loopbacks build the same classes.
 */
export function ownedByClient<T extends object>(capability: T, renew: (() => void) | undefined): T {
  return renew ? Object.assign(capability, { [clientActivity]: renew }) : capability;
}

/** Read the renewal a capability was marked with, to pass on to capabilities it mints. */
export function clientActivityOf(capability: object): (() => void) | undefined {
  return (capability as ClientCallTarget)[clientActivity];
}

/**
 * Renew the lease on every call a browser makes on `cls`'s methods (only on instances marked by
 * ownedByClient). Applied after the class body so it composes with @validateRpc(). Symbol-keyed
 * members, [Symbol.dispose] above all, are not wrapped: letting go is not activity.
 */
export function renewOnClientCalls(cls: { prototype: object }): void {
  let proto = cls.prototype;
  for (let name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor") continue;
    let descriptor = Object.getOwnPropertyDescriptor(proto, name)!;
    if (typeof descriptor.value !== "function") continue;
    let original = descriptor.value as (...args: unknown[]) => unknown;
    Object.defineProperty(proto, name, {
      ...descriptor,
      value: function (this: ClientCallTarget, ...args: unknown[]): unknown {
        this[clientActivity]?.();
        return original.apply(this, args);
      },
    });
  }
}
