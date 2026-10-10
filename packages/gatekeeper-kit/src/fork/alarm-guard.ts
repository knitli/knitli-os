/**
 * Durable Object alarm guardrails for gatekeepers: the `ALARMS_DISABLED` kill switch, a floored
 * `scheduleAlarm`, and the `guardedAlarm` per-minute flood detector with failure backoff.
 * `ALARM_GUARD_KEY_PREFIX` is the storage prefix of the guard's counter: bulk cleanup of an object's
 * storage must skip it. Re-exported from
 * `@gadgets/observability/fork/alarm-guard`, which the workshop backend shares, so every Worker obeys
 * one emergency stop. Every gatekeeper `alarm()` starts with `haltIfAlarmsDisabled`.
 */
export {
  ALARM_DISABLED_PROBE_MS,
  ALARM_FLOOR_MS,
  ALARM_GUARD_KEY_PREFIX,
  alarmBackoffMs,
  alarmsDisabled,
  clearAlarmGuard,
  guardedAlarm,
  guardedAlarmFor,
  haltIfAlarmsDisabled,
  MAX_ALARM_RUNS_PER_MINUTE,
  scheduleAlarm,
  type AlarmGuardRecord,
  type AlarmGuardState,
  type AlarmKillSwitchEnv,
  type GuardedAlarmOptions,
  type ScheduleAlarmOptions,
} from "@gadgets/observability/fork/alarm-guard";
