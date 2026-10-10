/**
 * Durable Object alarm guardrails for gatekeepers: the `ALARMS_DISABLED` kill switch, a floored
 * `scheduleAlarm`, and the `guardedAlarm` circuit breaker with failure backoff. Re-exported from
 * `@gadgets/observability/fork/alarm-guard`, which the workshop backend shares, so every Worker obeys
 * one emergency stop. Every gatekeeper `alarm()` starts with `haltIfAlarmsDisabled`.
 */
export {
  ALARM_FLOOR_MS,
  ALARM_DISABLED_PROBE_MS,
  alarmBackoffMs,
  alarmsDisabled,
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
