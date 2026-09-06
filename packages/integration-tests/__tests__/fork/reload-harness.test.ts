import { describe, expect, it } from "vitest";
import { waitForReloadGeneration } from "../../src/fork/reload-harness.js";

const response = (generation: string) => Response.json({ generation });
describe("reload transport generation barrier", () => {
  it("does not accept a healthy response from the previous public generation", async () => {
    let calls = 0;
    await waitForReloadGeneration("new", async () => response(++calls === 1 ? "old" : "new"), {});
    expect(calls).toBe(3);
  });
  it("waits for every child generation before declaring the public route ready", async () => {
    let childCalls = 0;
    await waitForReloadGeneration("new", async () => response("new"), {
      child: async () => response(++childCalls === 1 ? "old" : "new"),
    });
    expect(childCalls).toBe(2);
  });
  it("checks the public proxy again after the child checks", async () => {
    let calls = 0;
    await waitForReloadGeneration("new", async () => response(++calls === 2 ? "old" : "new"), {
      child: async () => response("new"),
    });
    expect(calls).toBe(4);
  });
  it("bounds stale-generation polling and identifies the last observation", async () => {
    await expect(waitForReloadGeneration("new", async () => response("old"), {}, 10))
      .rejects.toThrow(/Reload generation new was not transport-ready within 10ms \(public: generation old\)/);
  });
  it("bounds a transport that ignores cancellation while awaiting internal readiness", async () => {
    const result = await Promise.race([
      waitForReloadGeneration("new", () => new Promise(() => {}), {}, 10).then(() => "unexpected readiness", error => String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve("transport remained pending"), 100)),
    ]);
    expect(result).toContain("public: Error: health deadline");
  });
  it("supplies an aborting deadline to health requests", async () => {
    let aborted = false;
    await expect(waitForReloadGeneration("new", signal => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("health deadline")); }, { once: true });
    }), {}, 10)).rejects.toThrow(/public: Error: health deadline/);
    expect(aborted).toBe(true);
  });
});
