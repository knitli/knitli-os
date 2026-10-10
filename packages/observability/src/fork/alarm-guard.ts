import { createLogger } from "../logger.js";

/**
 * Durable Object alarm guardrails: an emergency stop, a floor under re-arm times, a
 * per-minute flood detector, and failure backoff, so that no `alarm()` handler can become a self-re-arming
 * loop. See `docs/alarm-audit.md` for why every handler needs them.
 */

type AlarmGuardLogFields = {
  alarmKey?: string;
  count?: number;
  maxPerMinute?: number;
  failures?: number;
  retryAt?: number;
};

const logger = createLogger<AlarmGuardLogFields>({ component: "observability.alarm-guard" });

const HOUR_MS = 3_600_000;
const WINDOW_MS = 60_000;

/**
 * Runs per clock minute above which the flood detector opens. The detector exists to stop a
 * runaway re-arm loop, which makes thousands of runs a minute, not to rate-limit real traffic: the
 * busiest legitimate alarm here peaks near 500 runs a minute (see `docs/alarm-audit.md`), so this
 * leaves a margin of at least ten. Failing loops are stopped earlier by the failure backoff.
 */
export const MAX_ALARM_RUNS_PER_MINUTE = 6_000;

/** The earliest an alarm armed through {@link scheduleAlarm} may fire, relative to now. */
export const ALARM_FLOOR_MS = 1_000;

/** Prefix of the single storage key a guarded alarm keeps its counters under, when it must. */
export const ALARM_GUARD_KEY_PREFIX = "alarm-guard:";

/**
 * The slice of `DurableObjectState` the guard touches: the alarm and one synchronous KV key
 * (SQLite-backed Durable Objects only). A real `ctx` satisfies it structurally.
 */
export interface AlarmGuardState {
  readonly storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    readonly kv: {
      get<T>(key: string): T | undefined;
      put<T>(key: string, value: T): void;
      delete(key: string): boolean;
    };
  };
}

/**
 * The emergency-stop variable. Set the Worker var `ALARMS_DISABLED` to `"true"` and redeploy
 * to halt every alarm that checks it within minutes: each one deletes itself the next time it
 * fires.
 */
export type AlarmKillSwitchEnv = { readonly ALARMS_DISABLED?: string };

/** True when the deployment's `ALARMS_DISABLED` emergency stop is on. */
export function alarmsDisabled(env: object): boolean {
  return (env as AlarmKillSwitchEnv).ALARMS_DISABLED === "true";
}

/**
 * The kill-switch check every `alarm()` handler starts with: when `ALARMS_DISABLED` is on it
 * re-arms an hourly probe, logs `alarm.disabled`, and returns true, so the caller returns at once.
 */
export async function haltIfAlarmsDisabled(
  state: AlarmGuardState,
  env: object,
  key: string,
): Promise<boolean> {
  if (!alarmsDisabled(env)) return false;
  await halt(state, key);
  return true;
}

/** How often a halted alarm wakes to check whether `ALARMS_DISABLED` has been turned off. */
export const ALARM_DISABLED_PROBE_MS = HOUR_MS;

// Re-arms a probe rather than deleting the alarm: nothing else would wake the object once the
// switch is cleared (a redeploy does not invoke Durable Objects), so the work would stay dormant.
async function halt(state: AlarmGuardState, key: string): Promise<void> {
  await state.storage.setAlarm(Date.now() + ALARM_DISABLED_PROBE_MS);
  logger.warn("alarm halted by ALARMS_DISABLED", { event: "alarm.disabled", alarmKey: key });
}

/** Options for {@link scheduleAlarm}. */
export type ScheduleAlarmOptions = {
  /** Minimum delay from now. Defaults to {@link ALARM_FLOOR_MS}. */
  floorMs?: number;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Arms the alarm at `atMs`, but never earlier than `now + floorMs`, so a past or present target
 * (a backlog, or state that failed to advance) cannot fire the alarm in a tight loop. Returns the
 * time actually armed. Writes nothing besides the alarm.
 */
export async function scheduleAlarm(
  state: AlarmGuardState,
  atMs: number,
  { floorMs = ALARM_FLOOR_MS, now = Date.now }: ScheduleAlarmOptions = {},
): Promise<number> {
  const at = Math.max(atMs, now() + floorMs);
  await state.storage.setAlarm(at);
  return at;
}

/** Options for {@link guardedAlarm}. */
export type GuardedAlarmOptions = {
  /** Names the alarm in logs and in its storage key; unique per Durable Object class. */
  key: string;
  /** The kill switch: pass {@link alarmsDisabled}`(env)`. */
  disabled?: boolean;
  /** Runs allowed per clock minute before the circuit opens. Defaults to {@link MAX_ALARM_RUNS_PER_MINUTE}. */
  maxPerMinute?: number;
  /** Failure backoff: `min(baseMs * 2^(failures - 1), maxMs)`. Defaults to 30 s and 1 h. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Consecutive failures after which the guard stops re-arming. Defaults to 8. */
  maxConsecutiveFailures?: number;
  /**
   * While the circuit is open, re-arm once for the start of the next minute instead of leaving the
   * alarm off. Use it where an alarm that silently stops would lose work (a scheduler, a
   * keep-alive). Defaults to false.
   */
  deferWhenOpen?: boolean;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/** The guard's counters for one alarm: one small key, overwritten in place, never growing. */
export type AlarmGuardRecord = {
  /** Clock minute (`floor(ms / 1 min)`) that `count` belongs to. */
  bucket: number;
  /** Runs started in `bucket`. */
  count: number;
  /** Consecutive failed runs; 0 after a success. */
  failures: number;
};

/** The delay before retry `failures` (1-based): `min(baseMs * 2^(failures - 1), maxMs)`. */
export function alarmBackoffMs(
  failures: number,
  { baseMs = 30_000, maxMs = HOUR_MS }: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = Math.max(baseMs, ALARM_FLOOR_MS);
  return Math.min(base * 2 ** Math.max(failures - 1, 0), Math.max(maxMs, base));
}

/**
 * Wraps an `alarm()` body so it cannot loop:
 *
 * 1. With `disabled` (the `ALARMS_DISABLED` kill switch) it re-arms the hourly probe, logs
 *    `alarm.disabled`, and returns without running `run`.
 * 2. It counts runs per clock minute. Past `maxPerMinute` the circuit opens: it logs
 *    `alarm.circuit.open` once per minute at error level, skips `run`, and does not re-arm
 *    (or, with `deferWhenOpen`, re-arms for the next minute). The next minute closes it.
 * 3. If `run` throws, the guard owns the next alarm. It overrides whatever `run` armed with
 *    `now + backoff`, logs `alarm.failed`, and returns normally so the platform does not
 *    retry as well. A success resets the failure count.
 * 4. After `maxConsecutiveFailures` consecutive failures it deletes the alarm instead
 *    (`alarm.gave_up`). Only an outside re-arm, such as an RPC, runs it again, and the first
 *    success resets it.
 *
 * Cost: one KV read and one KV write per run, plus a second write when the failure count changes,
 * and an alarm read. When a run succeeds and leaves no alarm armed the key is deleted, so an idle
 * object returns to empty storage; a failing or given-up alarm keeps it.
 * The counters live in one small key (`alarm-guard:<key>`), overwritten in place. The run is
 * counted before `run` starts, so a run the runtime kills outright (CPU limit, eviction) still
 * advances the count and cannot hide a loop; its failure count cannot be recorded, so only the
 * flood detector bounds that case.
 */
export async function guardedAlarm(
  state: AlarmGuardState,
  options: GuardedAlarmOptions,
  run: () => Promise<void>,
): Promise<void> {
  const { key, maxPerMinute = MAX_ALARM_RUNS_PER_MINUTE, maxConsecutiveFailures = 8, now = Date.now } = options;
  const storage = state.storage;
  if (options.disabled) return halt(state, key);

  const storageKey = ALARM_GUARD_KEY_PREFIX + key;
  const bucket = Math.floor(now() / WINDOW_MS);
  const stored = storage.kv.get<AlarmGuardRecord>(storageKey);
  const previous = stored?.bucket === bucket ? stored.count : 0;
  const failures = stored?.failures ?? 0;
  const count = previous + 1;

  if (count > maxPerMinute) {
    if (previous <= maxPerMinute) {
      logger.error("alarm circuit open: too many runs this minute", {
        event: "alarm.circuit.open", alarmKey: key, count, maxPerMinute,
      });
      storage.kv.put<AlarmGuardRecord>(storageKey, { bucket, count, failures });
    }
    if (options.deferWhenOpen) await storage.setAlarm((bucket + 1) * WINDOW_MS);
    return;
  }

  storage.kv.put<AlarmGuardRecord>(storageKey, { bucket, count, failures });
  let nextFailures = 0;
  try {
    await run();
  } catch (error) {
    nextFailures = failures + 1;
    if (nextFailures >= maxConsecutiveFailures) {
      await storage.deleteAlarm();
      logger.error("alarm gave up after consecutive failures", {
        event: "alarm.gave_up", alarmKey: key, failures: nextFailures, error,
      });
    } else {
      const retryAt = now() + alarmBackoffMs(nextFailures, options.backoff);
      await storage.setAlarm(retryAt);
      logger.error("alarm failed; retrying with backoff", {
        event: "alarm.failed", alarmKey: key, failures: nextFailures, retryAt, error,
      });
    }
  }
  if (nextFailures === 0 && await storage.getAlarm() === null) {
    // The alarm chain ended: nothing can loop, so leave an idle object with empty storage.
    storage.kv.delete(storageKey);
  } else if (nextFailures !== failures) {
    storage.kv.put<AlarmGuardRecord>(storageKey, { bucket, count, failures: nextFailures });
  }
}

/**
 * The seam upstream `alarm()` handlers call: {@link guardedAlarm} with the `ALARMS_DISABLED` kill
 * switch read from `env` and `deferWhenOpen` on, so a tripped flood detector pauses the alarm for
 * the minute rather than dropping the work.
 */
export function guardedAlarmFor(
  state: AlarmGuardState,
  env: object,
  key: string,
  run: () => Promise<void>,
): Promise<void> {
  return guardedAlarm(state, { key, disabled: alarmsDisabled(env), deferWhenOpen: true }, run);
}
