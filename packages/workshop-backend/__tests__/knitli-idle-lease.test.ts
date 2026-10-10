// Fork: the client-activity lease (src/fork/idle-lease.ts). The decision logic runs against an
// injected clock and a fake host; the capability wrapper against a plain class.

import { describe, expect, it } from "vitest";
import {
  IdleLease, SESSION_LEASE_KEY, SESSION_LEASE_MS, WorkspaceSessionExpiredError, ownedByClient,
  reapIdleSession, renewOnClientCalls, type LeaseHost,
} from "../src/fork/idle-lease.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("IdleLease", () => {
  it("assertLive checks without arming or renewing", () => {
    let lease = new IdleLease(clock().now);
    lease.assertLive();
    expect(lease.alarmTime()).toBeUndefined();
  });

  it("is unarmed until a browser touches it, and the first touch says so", () => {
    let c = clock();
    let lease = new IdleLease(c.now);
    expect(lease.alarmTime()).toBeUndefined();
    expect(lease.decide(false, false)).toBe("none");
    expect(lease.touch()).toBe(true);
    expect(lease.touch()).toBe(false);
    expect(lease.alarmTime()).toBe(c.now() + SESSION_LEASE_MS);
  });

  it("defers while the lease is live, and a touch moves the deadline", () => {
    let c = clock();
    let lease = new IdleLease(c.now);
    lease.touch();
    c.advance(SESSION_LEASE_MS - 1);
    expect(lease.decide(false, false)).toBe("deferred");
    lease.touch();
    c.advance(SESSION_LEASE_MS - 1);
    expect(lease.decide(false, false)).toBe("deferred");
  });

  it("an early check leaves the window alone, so the deadline stays one lease from last activity", () => {
    let c = clock();
    let lease = new IdleLease(c.now);
    lease.touch();
    let deadline = lease.alarmTime();
    c.advance(1000);
    expect(lease.decide(false, false)).toBe("deferred");
    expect(lease.alarmTime()).toBe(deadline);
  });

  it("agent work and the kill switch defer an expired lease for a fresh window", () => {
    let c = clock();
    let lease = new IdleLease(c.now);
    lease.touch();
    c.advance(SESSION_LEASE_MS + 5);
    expect(lease.decide(true, false)).toBe("deferred");
    expect(lease.alarmTime()).toBe(c.now() + SESSION_LEASE_MS);
    c.advance(SESSION_LEASE_MS + 5);
    expect(lease.decide(false, true)).toBe("deferred");
    expect(lease.alarmTime()).toBe(c.now() + SESSION_LEASE_MS);
  });

  it("the end of a turn grants a full lease to read the answer", () => {
    let c = clock();
    let lease = new IdleLease(c.now);
    lease.touch();
    c.advance(SESSION_LEASE_MS - 10);
    lease.noteWorkEnded();
    c.advance(SESSION_LEASE_MS - 10);
    expect(lease.decide(false, false)).toBe("deferred");
  });

  it("commits expiry once: no further alarm, no further touches", () => {
    let c = clock();
    let lease = new IdleLease(c.now);
    lease.touch();
    c.advance(SESSION_LEASE_MS);
    expect(lease.decide(false, false)).toBe("ended");
    expect(lease.alarmTime()).toBeUndefined();
    expect(lease.decide(false, false)).toBe("none");
    expect(() => lease.touch()).toThrow(WorkspaceSessionExpiredError);
    expect(() => lease.assertLive()).toThrow(WorkspaceSessionExpiredError);
  });
});

describe("renewOnClientCalls", () => {
  class Cap {
    calls = 0;
    run() { this.calls++; return "ran"; }
    [Symbol.dispose]() { this.calls = -1; }
  }
  renewOnClientCalls(Cap);

  it("renews on calls from client-owned instances only", () => {
    let renewals = 0;
    let owned = ownedByClient(new Cap(), () => { renewals++; });
    let internal = new Cap();
    expect(owned.run()).toBe("ran");
    expect(internal.run()).toBe("ran");
    expect(renewals).toBe(1);
  });

  it("does not count letting go as activity", () => {
    let renewals = 0;
    ownedByClient(new Cap(), () => { renewals++; })[Symbol.dispose]();
    expect(renewals).toBe(0);
  });

  it("refuses the call when renewal throws", () => {
    let cap = ownedByClient(new Cap(), () => { throw new WorkspaceSessionExpiredError(); });
    expect(() => cap.run()).toThrow(WorkspaceSessionExpiredError);
    expect(cap.calls).toBe(0);
  });
});

describe("reapIdleSession", () => {
  function host(opts: { kv?: string | null | Error; agentWork?: boolean; flushFails?: boolean } = {}) {
    let c = clock();
    let events: string[] = [];
    let lease = new IdleLease(c.now);
    let flush = { fails: opts.flushFails ?? false };
    let h: LeaseHost = {
      lease,
      kv: {
        get: async (key: string) => {
          expect(key).toBe(SESSION_LEASE_KEY);
          if (opts.kv instanceof Error) throw opts.kv;
          return opts.kv ?? null;
        },
      } as unknown as KVNamespace,
      hasAgentWork: () => opts.agentWork ?? false,
      rearm: () => { events.push("rearm"); },
      flush: async () => { if (flush.fails) throw new Error("sync failed"); },
      abort: reason => { events.push(`abort:${reason}`); },
    };
    return { c, lease, h, events, flush };
  }

  it("notifies, re-arms without the lease, then aborts, in that order", async () => {
    let { c, lease, h, events } = host({ kv: "on" });
    lease.touch();
    lease.addNotifier(async () => { events.push("notify"); });
    c.advance(SESSION_LEASE_MS);
    await reapIdleSession(h);
    expect(events).toEqual(["rearm", "notify", "abort:idle session lease expired"]);
  });

  it("does nothing on an unarmed incarnation", async () => {
    let { h, events } = host();
    await reapIdleSession(h);
    expect(events).toEqual([]);
  });

  it("never aborts over running agent work", async () => {
    let { c, lease, h, events } = host({ kv: "on", agentWork: true });
    lease.touch();
    c.advance(SESSION_LEASE_MS * 3);
    await reapIdleSession(h);
    expect(events).toEqual(["rearm"]);
  });

  it("enforces only when enabled, and a KV failure leaves it disabled", async () => {
    for (let kv of [null, "off", new Error("kv down")]) {
      let disabled = host({ kv });
      disabled.lease.touch();
      disabled.c.advance(SESSION_LEASE_MS);
      await reapIdleSession(disabled.h);
      expect(disabled.events).toEqual(["rearm"]);
    }
  });

  it("keeps the expiry committed when the final flush fails, and resumes it without re-notifying", async () => {
    let { c, lease, h, events, flush } = host({ kv: "on", flushFails: true });
    lease.touch();
    lease.addNotifier(async () => { events.push("notify"); });
    c.advance(SESSION_LEASE_MS);
    await expect(reapIdleSession(h)).rejects.toThrow("sync failed");
    expect(events).toEqual(["rearm", "notify", "rearm"]);
    // Clients were told, so calls stay refused and the alarm comes back soon.
    expect(() => lease.touch()).toThrow(WorkspaceSessionExpiredError);
    expect(lease.alarmTime()).toBe(c.now() + 5_000);

    flush.fails = false;
    await reapIdleSession(h);
    expect(events).toEqual(
        ["rearm", "notify", "rearm", "rearm", "abort:idle session lease expired"]);
  });

  it("a released notifier is not told", async () => {
    let { c, lease, h, events } = host({ kv: "on" });
    lease.touch();
    let watch = lease.addNotifier(async () => { events.push("notify"); });
    watch[Symbol.dispose]();
    c.advance(SESSION_LEASE_MS);
    await reapIdleSession(h);
    expect(events).not.toContain("notify");
  });
});
