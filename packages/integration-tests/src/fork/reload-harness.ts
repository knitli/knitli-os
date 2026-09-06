// Wrangler update() observes reloadComplete before its asynchronous public proxy switch.
// Only health requests repeat here; callers reconnect and run application RPC exactly once.
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Harness } from "../harness.js";

export const WORKSHOP_RELOAD_MAIN = new URL("../../fixtures/fork/workshop-reload-probe.js", import.meta.url).pathname;
export const GATEKEEPER_RELOAD_MAIN = new URL("../../fixtures/fork/gatekeeper-reload-probe.js", import.meta.url).pathname;
const PROBE_PATH = "/__test/reload-generation";
type Probe = (signal: AbortSignal) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function waitForReloadGeneration(
  generation: string,
  primary: Probe,
  children: Record<string, Probe>,
  timeoutMs = 30_000,
): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  // Miniflare can await its internal readiness before noticing a fetch AbortSignal.
  // Race the complete health read as well, so a stalled transport cannot defeat the bound.
  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("health deadline")), { once: true });
  });
  let lastObservation = "no response";
  async function matches(name: string, probe: Probe): Promise<boolean> {
    try {
      const result = await Promise.race([deadline, (async () => {
        const response = await probe(signal);
        return { ok: response.ok, status: response.status, body: response.ok ? await response.json() : undefined };
      })()]);
      if (!result.ok) { lastObservation = `${name}: HTTP ${result.status}`; return false; }
      const body = result.body;
      const observed = typeof body === "object" && body !== null && "generation" in body ? body.generation : undefined;
      lastObservation = `${name}: generation ${String(observed)}`;
      return observed === generation;
    } catch (error) {
      lastObservation = `${name}: ${String(error)}`;
      return false;
    }
  }
  while (!signal.aborted) {
    const ready = await Promise.all([
      matches("public", primary),
      ...Object.entries(children).map(([name, probe]) => matches(name, probe)),
    ]);
    // Child readiness may have overlapped another public proxy switch. Check it last too.
    if (ready.every(Boolean) && await matches("public-final", primary) && !signal.aborted) return;
    try { await setTimeout(25, undefined, { signal }); } catch { break; }
  }
  throw new Error(`Reload generation ${generation} was not transport-ready within ${timeoutMs}ms (${lastObservation})`);
}

export async function reloadHarnessWorkers(harness: Harness, childNames: string[]): Promise<void> {
  const generation = randomUUID();
  await harness.server.update(options => ({ ...options, workers: options.workers.map(worker => {
    if (!("config" in worker)) throw new Error("Expected inline local Worker config");
    return { config: { ...worker.config, vars: { ...worker.config.vars, OPENAPI_ACCEPTANCE_RELOAD: generation } } };
  }) }));
  await waitForReloadGeneration(generation,
    signal => fetch(new URL(PROBE_PATH, harness.url), { signal, cache: "no-store" }),
    Object.fromEntries(childNames.map(name => [name, (signal: AbortSignal) =>
      harness.fetchWorker(name, `http://reload.test${PROBE_PATH}`, { signal })])),
  );
}
