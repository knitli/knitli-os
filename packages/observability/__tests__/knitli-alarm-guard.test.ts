import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ALARM_GUARD_KEY_PREFIX,
  ALARM_RUNS_PER_HOUR,
  alarmBackoffMs,
  alarmsDisabled,
  guardedAlarm,
  guardedAlarmFor,
  haltIfAlarmsDisabled,
  scheduleAlarm,
  type AlarmGuardRecord,
  type AlarmGuardState,
  type GuardedAlarmOptions,
} from "../src/fork/alarm-guard.js";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR); // the start of a clock hour

/** An in-memory Durable Object slice with a fake clock and per-call write accounting. */
class FakeState implements AlarmGuardState {
  clock = T0;
  alarm: number | null = null;
  map = new Map<string, unknown>();
  writes = 0;
  alarmWrites: number[] = [];
  readonly now = () => this.clock;
  readonly storage = {
    setAlarm: async (at: number) => {
      this.alarm = at;
      this.alarmWrites.push(at);
    },
    deleteAlarm: async () => {
      this.alarm = null;
    },
    kv: {
      get: <T>(key: string) => this.map.get(key) as T | undefined,
      put: <T>(key: string, value: T) => {
        this.writes++;
        this.map.set(key, structuredClone(value));
      },
      delete: (key: string) => {
        this.writes++;
        return this.map.delete(key);
      },
    },
  };

  /** The same storage seen by a fresh instance, as after the object was evicted from memory. */
  evicted(): FakeState {
    const next = new FakeState();
    next.clock = this.clock;
    next.alarm = this.alarm;
    next.map = this.map;
    return next;
  }

  record(key: string): AlarmGuardRecord | undefined {
    return this.map.get(ALARM_GUARD_KEY_PREFIX + key) as AlarmGuardRecord | undefined;
  }

  /** Runs the guard as the runtime would fire the alarm, returning the writes it made. */
  async fire(options: Partial<GuardedAlarmOptions>, run: () => Promise<void>): Promise<number> {
    const before = this.writes;
    await guardedAlarm(this, { key: "test", now: this.now, ...options }, run);
    return this.writes - before;
  }
}

const ok = async () => {};
const boom = async () => {
  throw new Error("boom");
};

describe("alarm guard", () => {
  let state: FakeState;
  let warn: MockInstance<(...data: unknown[]) => void>;
  let error: MockInstance<(...data: unknown[]) => void>;
  beforeEach(() => {
    state = new FakeState();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads the kill switch only from the exact string \"true\"", () => {
    expect(alarmsDisabled({ ALARMS_DISABLED: "true" })).toBe(true);
    expect(alarmsDisabled({ ALARMS_DISABLED: "1" })).toBe(false);
    expect(alarmsDisabled({})).toBe(false);
  });

  it("kill switch deletes the alarm, logs once, and never runs the body", async () => {
    state.alarm = T0 + 10;
    const run = vi.fn(ok);
    expect(await state.fire({ disabled: true }, run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(state.alarm).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "alarm.disabled", alarmKey: "test",
    }));
  });

  it("haltIfAlarmsDisabled is a no-op unless the switch is on", async () => {
    state.alarm = T0 + 10;
    expect(await haltIfAlarmsDisabled(state, {}, "k")).toBe(false);
    expect(state.alarm).toBe(T0 + 10);
    expect(await haltIfAlarmsDisabled(state, { ALARMS_DISABLED: "true" }, "k")).toBe(true);
    expect(state.alarm).toBeNull();
    expect(state.writes).toBe(0);
  });

  it("scheduleAlarm never arms at or before now", async () => {
    expect(await scheduleAlarm(state, T0 - 5_000, { now: state.now })).toBe(T0 + 1_000);
    expect(await scheduleAlarm(state, T0, { now: state.now })).toBe(T0 + 1_000);
    expect(await scheduleAlarm(state, T0 + 60_000, { now: state.now })).toBe(T0 + 60_000);
    expect(state.writes).toBe(0);
  });

  it("happy path runs the body, leaves its alarm alone, and writes one counter key per run", async () => {
    const run = vi.fn(async () => {
      await state.storage.setAlarm(T0 + 60_000);
    });
    for (let i = 0; i < 60; i++) expect(await state.fire({}, run)).toBe(1);
    expect(run).toHaveBeenCalledTimes(60);
    expect(state.alarm).toBe(T0 + 60_000);
    expect(state.map.size).toBe(1);
  });

  it("persists the hourly count from the first run, so eviction at any point does not reset it", async () => {
    const run = vi.fn(ok);
    await state.fire({ maxPerHour: 10 }, run);
    expect(state.record("test")).toEqual({ bucket: T0 / HOUR, count: 1, failures: 0 });
    for (let i = 0; i < 2; i++) await state.fire({ maxPerHour: 10 }, run);

    // Evicted well under half the budget: the new instance carries on from 3, not from 0.
    const fresh = state.evicted();
    for (let i = 0; i < 8; i++) await fresh.fire({ maxPerHour: 10 }, run);
    expect(run).toHaveBeenCalledTimes(10);
    expect(fresh.record("test")!.count).toBe(11);
  });

  it("opens the circuit past maxPerHour, without re-arming, logging once", async () => {
    const run = vi.fn(async () => {
      await state.storage.setAlarm(state.clock); // a body that re-arms at now: the loop
    });
    for (let i = 0; i < 5; i++) {
      await state.fire({ maxPerHour: 5 }, run);
      state.clock += 1;
    }
    expect(run).toHaveBeenCalledTimes(5);

    state.alarm = null;
    expect(await state.fire({ maxPerHour: 5 }, run)).toBeLessThanOrEqual(1);
    expect(run).toHaveBeenCalledTimes(5);
    expect(state.alarm).toBeNull();
    // Further runs in the same hour cost no writes and log nothing.
    expect(await state.fire({ maxPerHour: 5 }, run)).toBe(0);
    expect(await state.fire({ maxPerHour: 5 }, run)).toBe(0);
    const opens = error.mock.calls
      .filter(([fields]) => (fields as { event?: string }).event === "alarm.circuit.open");
    expect(opens).toHaveLength(1);
    expect(opens[0]![0]).toEqual(expect.objectContaining({ alarmKey: "test", count: 6 }));
  });

  it("guardedAlarmFor honours the kill switch and a raised maxPerHour", async () => {
    const run = vi.fn(ok);
    for (let i = 0; i < 150; i++) await guardedAlarmFor(state, {}, "k", run, { maxPerHour: 200 });
    expect(run).toHaveBeenCalledTimes(150);
    // The default cap still applies without the option, and defers rather than drops.
    for (let i = 0; i < 125; i++) await guardedAlarmFor(state, {}, "d", run);
    expect(run).toHaveBeenCalledTimes(150 + 120);
    expect(state.alarm).toBe((Math.floor(Date.now() / HOUR) + 1) * HOUR); // real clock: no `now` option
    state.alarm = T0 + 5;
    await guardedAlarmFor(state, { ALARMS_DISABLED: "true" }, "k", run);
    expect(state.alarm).toBeNull();
  });

  it("guardedAlarmFor uses the listed cap for a key, and a listed cap exceeds the default", async () => {
    const run = vi.fn(ok);
    expect(ALARM_RUNS_PER_HOUR["scheduler"]).toBeGreaterThan(120);
    for (let i = 0; i < 200; i++) await guardedAlarmFor(state, {}, "scheduler", run);
    expect(run).toHaveBeenCalledTimes(200);
  });

  it("deferWhenOpen re-arms for the next hour, never sooner", async () => {
    for (let i = 0; i < 3; i++) await state.fire({ maxPerHour: 2, deferWhenOpen: true }, ok);
    expect(state.alarm).toBe(T0 + HOUR);
  });

  it("closes the circuit when the hour rolls over", async () => {
    const run = vi.fn(ok);
    for (let i = 0; i < 4; i++) await state.fire({ maxPerHour: 2 }, run);
    expect(run).toHaveBeenCalledTimes(2);
    state.clock = T0 + HOUR;
    await state.fire({ maxPerHour: 2 }, run);
    expect(run).toHaveBeenCalledTimes(3);
    // Also after an eviction: the persisted open-circuit record belongs to the old hour.
    const fresh = state.evicted();
    fresh.clock = T0 + 2 * HOUR;
    await fresh.fire({ maxPerHour: 2 }, run);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("backs off 30 s, 60 s, 120 s ... capped at 1 h, overriding the body's re-arm", async () => {
    const delays: number[] = [];
    const run = async () => {
      await state.storage.setAlarm(state.clock); // re-arms at now, then fails
      throw new Error("boom");
    };
    for (let i = 0; i < 7; i++) {
      await state.fire({ maxConsecutiveFailures: 100 }, run);
      delays.push(state.alarm! - state.clock);
      state.clock = state.alarm!;
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000]);
    expect(alarmBackoffMs(8)).toBe(HOUR);
    expect(alarmBackoffMs(30)).toBe(HOUR);
    expect(alarmBackoffMs(1, { baseMs: 0 })).toBe(1_000);
  });

  it("never itself arms the alarm at or before now, on any path", async () => {
    const runs = [ok, boom, boom, ok, boom, boom, boom, boom, boom, boom, boom, ok];
    for (const [i, run] of runs.entries()) {
      const before = state.alarmWrites.length;
      await state.fire({ maxPerHour: 9, deferWhenOpen: i % 2 === 0 }, run);
      for (const at of state.alarmWrites.slice(before)) expect(at).toBeGreaterThan(state.clock);
      state.clock += 1_000;
    }
    expect(state.alarmWrites.length).toBeGreaterThan(0);
  });

  it("gives up after N consecutive failures and stops re-arming", async () => {
    for (let i = 1; i < 8; i++) {
      await state.fire({}, boom);
      expect(state.alarm).not.toBeNull();
      state.clock = state.alarm!;
    }
    await state.storage.setAlarm(state.clock); // the body's own re-arm must not survive
    await state.fire({}, async () => {
      await state.storage.setAlarm(state.clock);
      throw new Error("boom");
    });
    expect(state.alarm).toBeNull();
    expect(state.record("test")!.failures).toBe(8);
    expect(error).toHaveBeenLastCalledWith(expect.objectContaining({
      event: "alarm.gave_up", alarmKey: "test", failures: 8,
    }));
  });

  it("a success resets the failure count", async () => {
    await state.fire({}, boom);
    await state.fire({}, boom);
    expect(state.record("test")!.failures).toBe(2);
    // The failure count survives eviction, so backoff keeps growing across restarts.
    const fresh = state.evicted();
    await fresh.fire({}, boom);
    expect(fresh.alarm).toBe(fresh.clock + 120_000);
    await fresh.fire({}, ok);
    expect(fresh.record("test")!.failures).toBe(0);
    await fresh.fire({}, boom);
    expect(fresh.alarm).toBe(fresh.clock + 30_000);
  });

  it("writes at most one storage key per invocation on every path", async () => {
    const counts = [
      await state.fire({}, ok),
      await state.fire({}, boom),
      await state.fire({}, ok),
      await state.fire({ disabled: true }, ok),
    ];
    for (let i = 0; i < 4; i++) counts.push(await state.fire({ maxPerHour: 4 }, boom));
    expect(counts).toEqual([1, 1, 1, 0, 1, 1, 0, 0]);
    expect(state.map.size).toBeLessThanOrEqual(1);
  });

  it("keeps separate counters per key", async () => {
    await state.fire({ key: "a" }, boom);
    await state.fire({ key: "b" }, ok);
    expect(state.record("a")!.failures).toBe(1);
    expect(state.record("b")!.failures).toBe(0);
  });
});
