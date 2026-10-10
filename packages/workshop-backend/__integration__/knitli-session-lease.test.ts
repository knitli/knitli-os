// Fork: the workspace client-activity lease (src/fork/idle-lease.ts), end to end: a real /api
// socket, a real workspace and the object's own alarm. Adapted from twinprime19/cloudflare-os's
// session-lease suite.
//
// `vi.setSystemTime` reaches `Date.now()` inside the Durable Object under vitest-pool-workers, so
// the lease needs no test-only clock. Only `Date` is faked: the sockets, the RPC layer and the
// reap's notification cap run on real timers.

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { keyString } from "@gadgets/typed-storage";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";
import { SESSION_IDLE_CLOSE_CODE } from "@gadgets/workshop-shared/api";
import { SESSION_LEASE_KEY, SESSION_LEASE_MS } from "../src/fork/idle-lease";
import server from "../src/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PASSWORD_HASH = new Uint8Array([1, 2, 3]);
const DELIVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
const PAST_THE_LEASE_MS = SESSION_LEASE_MS + 60_000;
const LEASE_ABORT_REASON = "idle session lease expired";

type LogFields = Record<string, unknown>;
type SocketClose = { code: number; reason: string };
type Session = { publicApi: RpcStub<PublicApi>; closes: SocketClose[] };

function spyOnLogs() {
  return vi.spyOn(console, "info").mockImplementation(() => {});
}

function loggedEvents(logs: ReturnType<typeof spyOnLogs>, event: string): LogFields[] {
  return logs.mock.calls
      .map(call => call[0] as LogFields | undefined)
      .filter((fields): fields is LogFields => fields?.event === event);
}

// Counted in polls, never in wall-clock time: these tests move the clock.
async function waitFor<T>(what: string, poll: () => T | undefined | null): Promise<T> {
  for (let attempt = 0; attempt < 1000; ++attempt) {
    const value = poll();
    if (value !== undefined && value !== null) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

const settle = () => new Promise(resolve => setTimeout(resolve, 200));

function advanceBeyondTheLease(): void {
  vi.setSystemTime(Date.now() + PAST_THE_LEASE_MS);
}

async function signIn(): Promise<{
  session: Session; authenticated: RpcStub<AuthenticatedApi>; token: string;
}> {
  // Invoke the handler directly so the WebSocket session shares the test's execution context.
  const response = await server.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }), env, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const closes: SocketClose[] = [];
  socket.addEventListener("close", event => { closes.push({ code: event.code, reason: event.reason }); });
  const publicApi = newWebSocketRpcSession<PublicApi>(socket);

  const name = "lease" + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(name, name, PASSWORD_HASH);
  if (token === null) throw new Error(`Failed to create ${name}.`);
  return { session: { publicApi, closes }, authenticated: await publicApi.authenticate(token), token };
}

function overseerStub(id: string) {
  return exports.OverseerDurableObject.get(exports.OverseerDurableObject.idFromString(id));
}

function scheduledAlarm(id: string): Promise<number | null> {
  return runInDurableObject(overseerStub(id), (_instance, state) => state.storage.getAlarm());
}

// A reap aborts the object from inside the alarm handler, so the invocation that reaped fails:
// that rejection is the success signal.
async function runAlarm(id: string): Promise<{ ran: boolean; aborted: boolean }> {
  try {
    return { ran: await runDurableObjectAlarm(overseerStub(id)), aborted: false };
  } catch (error) {
    if (error instanceof Error && error.message.includes(LEASE_ABORT_REASON)) {
      return { ran: true, aborted: true };
    }
    throw error;
  }
}

describe("workspace client-activity lease", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The lease is opt-in (see SESSION_LEASE_KEY); every case but the default-off one enables it.
    await env.BLUEPRINTS.put(SESSION_LEASE_KEY, "on");
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await env.BLUEPRINTS.delete(SESSION_LEASE_KEY);
  });

  it("ends a workspace nothing has touched for a lease, and tells the browser why", async () => {
    const logs = spyOnLogs();
    const { session, authenticated } = await signIn();
    const workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();
    const subscription = await workspace.subscribeToMetadata(() => {});

    advanceBeyondTheLease();
    // Traffic that never reaches this workspace is not activity on it.
    await session.publicApi.ping();
    expect(await authenticated.listGadgets()).toBeInstanceOf(Array);
    await runAlarm(metadata.id);

    expect(await waitFor("the idle close", () => session.closes[0]))
        .toEqual({ code: SESSION_IDLE_CLOSE_CODE, reason: "idle" });
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toHaveLength(1);
    await expect(workspace.getMetadata()).rejects.toThrow();
    expect(await scheduledAlarm(metadata.id)).toBe(null);
    subscription[Symbol.dispose]();
  });

  it("renews on a client call and re-arms the alarm a lease after that call", async () => {
    const logs = spyOnLogs();
    const { session, authenticated } = await signIn();
    const workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await workspace.getMetadata();
    const renewedAt = Date.now();

    // The first touch armed the alarm, so it fires early; finding the lease renewed, it must leave
    // the lease clock alone and re-arm exactly one lease after the renewal.
    vi.setSystemTime(renewedAt + SESSION_LEASE_MS - 2 * 60_000);
    expect(await runAlarm(metadata.id)).toEqual({ ran: true, aborted: false });
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toEqual([]);
    expect(session.closes).toEqual([]);
    expect(await scheduledAlarm(metadata.id)).toBe(renewedAt + SESSION_LEASE_MS);

    vi.setSystemTime(renewedAt + PAST_THE_LEASE_MS);
    await runAlarm(metadata.id);
    expect(await waitFor("the idle close", () => session.closes[0]))
        .toEqual({ code: SESSION_IDLE_CLOSE_CODE, reason: "idle" });
  });

  it("defers to outstanding agent work and reaps once the work is gone", async () => {
    const logs = spyOnLogs();
    const { session, authenticated } = await signIn();
    using workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();

    // A recorded call to a callable agent: agent work without a model to run it. The reap is
    // called directly because the alarm's other concerns would drain the record first.
    await runInDurableObject(overseerStub(metadata.id), instance => {
      asImpl(instance).storage.pendingAgentCalls.put({
        chatId: 1, callId: 1, methodName: "doWork", args: [], argsSummary: "()",
        initiatorUserId: "unused", initiatorModelId: null,
      });
    });
    advanceBeyondTheLease();
    await runInDurableObject(overseerStub(metadata.id), instance => asImpl(instance).reapIdleSession());
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toEqual([]);
    expect(session.closes).toEqual([]);
    expect(await workspace.getMetadata()).toEqual(expect.objectContaining({ id: metadata.id }));

    // The deferral is not a latch: with the work gone and nobody back, the next check ends it.
    await runInDurableObject(overseerStub(metadata.id), instance => {
      asImpl(instance).storage.pendingAgentCalls.delete(`${keyString(1)}.${keyString(1)}`);
    });
    advanceBeyondTheLease();
    await runAlarm(metadata.id);
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toHaveLength(1);
  });

  it("closes the socket only once no workspace is left open on the session", async () => {
    const { session, authenticated } = await signIn();
    const first = await authenticated.newGadget();
    const firstId = (await first.getMetadata()).id;
    using second = await authenticated.newGadget();
    const secondId = (await second.getMetadata()).id;

    // The first workspace's lease is what ends it, while the second is live on the same socket.
    advanceBeyondTheLease();
    await second.getMetadata();
    await runAlarm(firstId);
    await settle();
    expect(session.closes).toEqual([]);
    expect(await second.getMetadata()).toEqual(expect.objectContaining({ id: secondId }));

    first[Symbol.dispose]();
    advanceBeyondTheLease();
    await runAlarm(secondId);
    expect(await waitFor("the idle close", () => session.closes[0]))
        .toEqual({ code: SESSION_IDLE_CLOSE_CODE, reason: "idle" });
  });

  it("keeps the idle close pending when a later non-idle release empties the socket", async () => {
    const { session, authenticated } = await signIn();
    const idleOne = await authenticated.newGadget();
    const idleId = (await idleOne.getMetadata()).id;
    const temporary = await authenticated.newGadget();
    const temporaryId = (await temporary.getMetadata()).id;

    advanceBeyondTheLease();
    await temporary.getMetadata();
    await runAlarm(idleId);
    await settle();
    expect(session.closes).toEqual([]);

    // The temporary open goes away normally; the socket still owes the idle close.
    temporary[Symbol.dispose]();
    expect(temporaryId).not.toBe(idleId);
    expect(await waitFor("the idle close", () => session.closes[0]))
        .toEqual({ code: SESSION_IDLE_CLOSE_CODE, reason: "idle" });
  });

  it("shares the open count across authenticated capabilities on one socket", async () => {
    const { session, authenticated, token } = await signIn();
    const second = await session.publicApi.authenticate(token);
    const first = await authenticated.newGadget();
    const firstId = (await first.getMetadata()).id;
    using other = await second.newGadget();
    const otherId = (await other.getMetadata()).id;

    // The first capability's workspace idles while the second capability's is live on the socket.
    advanceBeyondTheLease();
    await other.getMetadata();
    await runAlarm(firstId);
    await settle();
    expect(session.closes).toEqual([]);

    first[Symbol.dispose]();
    advanceBeyondTheLease();
    await runAlarm(otherId);
    expect(await waitFor("the idle close", () => session.closes[0]))
        .toEqual({ code: SESSION_IDLE_CLOSE_CODE, reason: "idle" });
  });

  it("releases a workspace once when the client vanishes mid-call, and never loops", async () => {
    const logs = spyOnLogs();
    const { session, authenticated } = await signIn();
    const workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();

    const lost = workspace.listActions({ filter: "action" }).catch(() => "lost");
    session.publicApi[Symbol.dispose]();
    await lost;
    await settle();

    advanceBeyondTheLease();
    await runAlarm(metadata.id);
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toHaveLength(1);

    // The incarnation the alarm wakes next has seen no browser, so it arms and aborts nothing.
    expect(await runAlarm(metadata.id)).toEqual({ ran: false, aborted: false });
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toHaveLength(1);
    expect(await scheduledAlarm(metadata.id)).toBe(null);
  });

  it("leaves another concern's alarm behind when it ends the object", async () => {
    const { authenticated } = await signIn();
    using workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();

    // A delivered external-message response is kept for a day: a legitimate deadline the expiry
    // must not drop.
    const deliveredAt = Date.now();
    await runInDurableObject(overseerStub(metadata.id), instance => {
      asImpl(instance).storage.gadgetResponseDeliveries.put({
        idempotencyKey: "delivered-response", chatId: 1, promptSequence: 1,
        createdAt: deliveredAt, status: "delivered", deliveredAt,
      });
    });
    advanceBeyondTheLease();
    await runAlarm(metadata.id);
    expect(await scheduledAlarm(metadata.id)).toBe(deliveredAt + DELIVERY_RETENTION_MS);
  });

  // The kernel can land before the UI that understands the idle close code, so unless a deployment
  // opts in the lease must not end anything.
  it.each([["absent", null], ["off", "off"]])("enforces nothing unless enabled (%s)", async (_label, value) => {
    await env.BLUEPRINTS.delete(SESSION_LEASE_KEY);
    if (value !== null) await env.BLUEPRINTS.put(SESSION_LEASE_KEY, value);
    const { session, authenticated } = await signIn();
    using workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();

    advanceBeyondTheLease();
    const checkedAt = Date.now();
    expect(await runAlarm(metadata.id)).toEqual({ ran: true, aborted: false });
    expect(session.closes).toEqual([]);
    // Still armed one lease out, so enabling the flag takes effect at the next check.
    const alarm = await scheduledAlarm(metadata.id);
    expect(alarm! - checkedAt).toBeGreaterThan(SESSION_LEASE_MS - 10_000);
    expect(alarm! - checkedAt).toBeLessThanOrEqual(SESSION_LEASE_MS);
  });

  it("reaps an expired workspace even when another alarm concern fails, and still reports the failure",
      async () => {
    const logs = spyOnLogs();
    const { authenticated } = await signIn();
    using workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();
    await runInDurableObject(overseerStub(metadata.id), instance => {
      asImpl(instance).runAlarmTasks = async () => { throw new Error("delivery failed"); };
    });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    advanceBeyondTheLease();
    await runAlarm(metadata.id);
    expect(loggedEvents(logs, "overseer.session.lease.expired")).toHaveLength(1);
    // The failure is logged before the abort, which is all the platform would otherwise see.
    expect(errors.mock.calls.some(call =>
        (call[0] as LogFields | undefined)?.event === "overseer.alarm.task.failed")).toBe(true);
  });

  it("does not arm the lease for a caller who has no access to the workspace", async () => {
    const owner = await signIn();
    const workspace = await owner.authenticated.newGadget();
    const metadata = await workspace.getMetadata();
    workspace[Symbol.dispose]();
    advanceBeyondTheLease();
    await runAlarm(metadata.id);
    expect(await scheduledAlarm(metadata.id)).toBe(null);

    // A fresh incarnation, opened by a stranger: denied, and nothing is left armed.
    const stranger = await signIn();
    await expect(stranger.authenticated.openGadget(metadata.id)).rejects.toThrow();
    expect(await scheduledAlarm(metadata.id)).toBe(null);
  });

  it("does not let a failed open leak a count that would stop the idle close", async () => {
    const { session, authenticated } = await signIn();
    using workspace = await authenticated.newGadget();
    const metadata = await workspace.getMetadata();
    await expect(authenticated.openGadget(exports.OverseerDurableObject.newUniqueId().toString()))
        .rejects.toThrow();

    advanceBeyondTheLease();
    await runAlarm(metadata.id);
    expect(await waitFor("the idle close", () => session.closes[0]))
        .toEqual({ code: SESSION_IDLE_CLOSE_CODE, reason: "idle" });
  });
});

// The workspace's OverseerImpl is TypeScript-private on the Durable Object; reaching it is a
// visibility escape for the cases the alarm cannot stage on its own.
type OverseerImplForTest = {
  reapIdleSession(): Promise<void>;
  runAlarmTasks(): Promise<void>;
  storage: {
    pendingAgentCalls: { put(record: object): void; delete(key: string): void };
    gadgetResponseDeliveries: { put(record: object): void };
  };
};

function asImpl(instance: object): OverseerImplForTest {
  return (instance as { impl: OverseerImplForTest }).impl;
}
