/** Bound recovery waits without accumulating duplicate unresolved connector operations. */
export const OPENAPI_RECOVERY_TIMEOUT_MS = 10_000;

/**
 * A timer expires the attempt's guards and caller's wait. Its slot stays occupied until the
 * actual operation settles: disposal does not guarantee remote cancellation. An eternally
 * stuck operation therefore needs settlement or a Durable Object restart before retrying.
 */
export function createOpenApiRecoveryRunner() {
  const pending = new Map<string, Promise<void>>();
  return {
    run(key: string, operation: (assertCurrent: () => void) => Promise<void>): Promise<void> {
      const existing = pending.get(key);
      if (existing) return existing;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      pending.set(key, result);
      let expired = false;
      const timeout = new Error("OPENAPI_RECOVERY_TIMEOUT");
      const timer = setTimeout(() => { expired = true; reject(timeout); }, OPENAPI_RECOVERY_TIMEOUT_MS);
      const assertCurrent = () => { if (expired) throw timeout; };
      const finish = () => { clearTimeout(timer); pending.delete(key); };
      Promise.resolve().then(() => operation(assertCurrent)).then(
        () => { finish(); resolve(); },
        error => { finish(); reject(error); },
      );
      return result;
    },
  };
}
