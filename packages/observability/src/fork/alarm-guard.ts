import { createLogger } from "../logger.js";

/**
 * Durable Object alarm guardrails: an emergency stop, a floor under re-arm times, an hourly
 * circuit breaker, and failure backoff, so that no `alarm()` handler can become a self-re-arming
 * loop. See `docs/alarm-audit.md` for why every handler needs them.
 */

type AlarmGuardLogFields = {
  alarmKey?: string;
  count?: number;
  maxPerHour?: number;
  failures?: number;
  retryAt?: number;
};

const logger = createLogger<AlarmGuardLogFields>({ component: "observability.alarm-guard" });

const HOUR_MS = 3_600_000;

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
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    readonly kv: {
      get<T>(key: string): T | undefined;
      put<T>(key: string, value: T): void;
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
  /** Runs allowed per clock hour before the circuit opens. Defaults to 120. */
  maxPerHour?: number;
  /** Failure backoff: `min(baseMs * 2^(failures - 1), maxMs)`. Defaults to 30 s and 1 h. */
  backoff?: { baseMs?: number; maxMs?: number };
  /** Consecutive failures after which the guard stops re-arming. Defaults to 8. */
  maxConsecutiveFailures?: number;
  /**
   * While the circuit is open, re-arm once for the start of the next hour instead of leaving the
   * alarm off. Use it where an alarm that silently stops would lose work (a scheduler, a
   * keep-alive). Defaults to false.
   */
  deferWhenOpen?: boolean;
  /** The clock, for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/** The guard's counters for one alarm: one small key, overwritten in place, never growing. */
export type AlarmGuardRecord = {
  /** Clock hour (`floor(ms / 1h)`) that `count` belongs to. */
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
 * 2. It counts runs per clock hour. Past `maxPerHour` the circuit opens: it logs
 *    `alarm.circuit.open` once per hour at error level, skips `run`, and does not re-arm
 *    (or, with `deferWhenOpen`, re-arms for the next hour). The next hour closes it.
 * 3. If `run` throws, the guard owns the next alarm. It overrides whatever `run` armed with
 *    `now + backoff`, logs `alarm.failed`, and returns normally so the platform does not
 *    retry as well. A success resets the failure count.
 * 4. After `maxConsecutiveFailures` consecutive failures it deletes the alarm instead
 *    (`alarm.gave_up`). Only an outside re-arm, such as an RPC, runs it again, and the first
 *    success resets it.
 *
 * Cost: one KV read and one KV write per run. The counters live in one small key
 * (`alarm-guard:<key>`), overwritten in place, and are always persisted rather than held in
 * memory, because a Durable Object that is evicted mid-hour would otherwise restart its count and
 * exceed the cap. Counters are updated after `run`, so a run the runtime kills outright (CPU
 * limit, eviction) is not counted; the platform's own bounded retry covers that case.
 */
export async function guardedAlarm(
  state: AlarmGuardState,
  options: GuardedAlarmOptions,
  run: () => Promise<void>,
): Promise<void> {
  const { key, maxPerHour = 120, maxConsecutiveFailures = 8, now = Date.now } = options;
  const storage = state.storage;
  if (options.disabled) return halt(state, key);

  const storageKey = ALARM_GUARD_KEY_PREFIX + key;
  const bucket = Math.floor(now() / HOUR_MS);
  const stored = storage.kv.get<AlarmGuardRecord>(storageKey);
  const previous = stored?.bucket === bucket ? stored.count : 0;
  const failures = stored?.failures ?? 0;
  const count = previous + 1;

  if (count > maxPerHour) {
    if (previous <= maxPerHour) {
      logger.error("alarm circuit open: too many runs this hour", {
        event: "alarm.circuit.open", alarmKey: key, count, maxPerHour,
      });
      storage.kv.put<AlarmGuardRecord>(storageKey, { bucket, count, failures });
    }
    if (options.deferWhenOpen) await storage.setAlarm((bucket + 1) * HOUR_MS);
    return;
  }

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
  storage.kv.put<AlarmGuardRecord>(storageKey, { bucket, count, failures: nextFailures });
}

/**
 * Runs per clock hour that {@link guardedAlarmFor} allows each guarded alarm, by key. An entry is
 * the alarm's legitimate worst case with headroom, so only a loop reaches it; derivations are in
 * `docs/alarm-audit.md`. A key not listed gets the {@link guardedAlarm} default of 120.
 */
export const ALARM_RUNS_PER_HOUR: Readonly<Record<string, number>> = {
  // One run per workspace turn or response; a turn is an LLM call, so over 1 per second is a loop.
  overseer: 3_600,
  // 500 schedules at the 60 s minimum, staggered so each firing is its own run, plus 20%.
  scheduler: 36_000,
};

/**
 * Runs per clock hour a Google hook driver legitimately needs with `registrations` hooks. Gmail
 * documents at most one notification a second per watched user, so 3,600 push runs an hour; each
 * push queues a row per matching hook and a run drains `deliveriesPerRun` of them, adding
 * `3,600 * registrations / deliveriesPerRun` runs; an equal 3,600 covers retry, history-paging and
 * renewal runs. Chat documents no rate, so the same ceiling is assumed.
 */
export function hookAlarmRunsPerHour(registrations: number, deliveriesPerRun: number): number {
  return 7_200 + Math.ceil((3_600 * registrations) / deliveriesPerRun);
}

/**
 * The seam upstream `alarm()` handlers call: {@link guardedAlarm} with the `ALARMS_DISABLED` kill
 * switch read from `env`, `deferWhenOpen` on, and the cap {@link ALARM_RUNS_PER_HOUR} lists for
 * `key`, so a tripped breaker pauses the alarm for the hour rather than dropping the work.
 * `maxPerHour` overrides the cap.
 */
export function guardedAlarmFor(
  state: AlarmGuardState,
  env: object,
  key: string,
  run: () => Promise<void>,
  { maxPerHour = ALARM_RUNS_PER_HOUR[key] }: Pick<GuardedAlarmOptions, "maxPerHour"> = {},
): Promise<void> {
  return guardedAlarm(
    state, { key, disabled: alarmsDisabled(env), deferWhenOpen: true, maxPerHour }, run);
}
