import { describe, expect, it, vi } from "vitest";
import { RpcTarget } from "capnweb";
import type { BlueprintBinding, BlueprintBindingAssignment, GatekeeperClient } from "@gadgets/workshop-shared/api";
import {
  createBlueprintSetup, pendingBlueprintSetup, runBlueprintSetup, validateBlueprintAssignments,
  type BlueprintSetupContext, type BlueprintSetupState,
} from "../src/fork/blueprint-setup";

const sourceUrl = "https://workshop.test/gatekeeper/openapi/apis/source/releases/v1/grants/source";
const apiBinding: BlueprintBinding = {
  type: "gatekeeper", title: "Source API", description: "Pick a fresh API", gatekeeperName: "openapi",
  typeUrlPattern: "https://workshop.test/gatekeeper/openapi/apis/*", resourceUrl: sourceUrl,
};

function setupFixture(bindings: Record<string, BlueprintBinding>, assignments: Record<string, BlueprintBindingAssignment>) {
  let stored: BlueprintSetupState = createBlueprintSetup(bindings, assignments, 7);
  let nextId = 40;
  const edges = new Map<string, number>();
  const missing = new Set<number>();
  const events: string[] = [];
  const capability = (id: number) => new class extends RpcTarget implements GatekeeperClient<never> {
    async getId() { return id; }
    async getTitle() { return "Test connection"; }
    async setTitle() {}
    async remove() {}
    async describe(): Promise<never> { throw new Error("Unexpected describe"); }
    async openSession(): Promise<never> { throw new Error("Unexpected session"); }
    async getCreationSpec(): Promise<never> { throw new Error("Unexpected creation spec"); }
    [Symbol.dispose]() {}
  }();
  const newGatekeeper = vi.fn<BlueprintSetupContext["api"]["newGatekeeper"]>(async () => capability(nextId++));
  const newAiModelGatekeeper = vi.fn<BlueprintSetupContext["api"]["newAiModelGatekeeper"]>(async () => capability(nextId++));
  const newAgentSpawnerGatekeeper = vi.fn<BlueprintSetupContext["api"]["newAgentSpawnerGatekeeper"]>(async () => capability(nextId++));
  const validateGatekeeper = vi.fn<BlueprintSetupContext["validateGatekeeper"]>().mockResolvedValue();
  const bind = vi.fn<BlueprintSetupContext["bind"]>((gadgetId, name, id) => {
    expect(gadgetId).toBe(7);
    expect(stored.resolved[name]).toBe(id);
    events.push(`bind:${name}:${id}`);
    edges.set(name, id);
  });
  // Every read/write clones the manifest. A new context after failure cannot retain a live object.
  const restart = (): BlueprintSetupContext => ({
    get: () => structuredClone(stored),
    put: state => { stored = structuredClone(state); events.push("persist"); },
    api: { newGatekeeper, newAiModelGatekeeper, newAgentSpawnerGatekeeper },
    assertOwner: () => {}, validateGatekeeper, bind, isMissing: id => missing.has(id),
  });
  return { restart, read: () => structuredClone(stored), edges, missing, events, bind, validateGatekeeper,
    newGatekeeper, newAiModelGatekeeper, newAgentSpawnerGatekeeper };
}

describe("durable deferred blueprint setup", () => {
  it("requires explicit deferral for a protocol-enabled account and rejects incompatible deferred accounts", async () => {
    const describe = vi.fn<Parameters<typeof validateBlueprintAssignments>[2]>().mockResolvedValue({
      vendorId: "openapi", description: { avatar: { url: "https://workshop.test/icon.png" }, hostBindingProtocol: "openapi-v1" },
      supportedResources: [{ urlPattern: apiBinding.typeUrlPattern, title: "API", description: "" }],
    });
    await expect(validateBlueprintAssignments({ SOURCE_API: apiBinding }, {
      SOURCE_API: { type: "gatekeeper", accountId: 3, resourceUrl: sourceUrl },
    }, describe)).rejects.toThrow("WORKSPACE_CONTEXT_REQUIRED");
    await expect(validateBlueprintAssignments({ SOURCE_API: apiBinding }, {
      SOURCE_API: { type: "deferredGatekeeper", accountId: 3 },
    }, describe)).resolves.toBeUndefined();
    describe.mockResolvedValueOnce(null);
    await expect(validateBlueprintAssignments({ SOURCE_API: apiBinding }, {
      SOURCE_API: { type: "deferredGatekeeper", accountId: 999 },
    }, describe)).rejects.toThrow('Binding "SOURCE_API" does not accept this deferred OpenAPI account.');
  });

  it("removes source suggestions and creates no capability until a fresh selection completes its exact binding", async () => {
    const f = setupFixture({ SOURCE_API: apiBinding }, { SOURCE_API: { type: "deferredGatekeeper", accountId: 3 } });
    await runBlueprintSetup(f.restart());
    expect(f.newGatekeeper).not.toHaveBeenCalled();
    expect(f.newAiModelGatekeeper).not.toHaveBeenCalled();
    expect(f.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
    expect(f.edges.size).toBe(0);
    expect(pendingBlueprintSetup(f.read())).toEqual({ gadgetId: 7, bindings: {
      SOURCE_API: { accountId: 3, binding: { ...apiBinding, resourceUrl: undefined } },
    } });
    expect(Object.hasOwn(f.read().bindings.SOURCE_API, "resourceUrl")).toBe(false);
    expect(apiBinding.resourceUrl).toBe(sourceUrl);
    await runBlueprintSetup(f.restart(), { bindingName: "SOURCE_API", gatekeeperId: 83 });
    expect(f.validateGatekeeper).toHaveBeenCalledExactlyOnceWith("SOURCE_API", 83);
    expect(f.edges.get("SOURCE_API")).toBe(83);
    expect(pendingBlueprintSetup(f.read())).toBeNull();
    await runBlueprintSetup(f.restart());
    expect(f.bind).toHaveBeenCalledOnce();
  });

  it("waits for every deferred spawner-only dependency, then creates the full environment without exposing dependencies on the gadget", async () => {
    const f = setupFixture({
      FIRST: { ...apiBinding, spawnerOnly: true }, SECOND: { ...apiBinding, spawnerOnly: true },
      RUN: { type: "agentSpawner", title: "Runner", description: "", env: {
        API_A: { type: "binding", name: "FIRST" }, API_B: { type: "binding", name: "SECOND" },
        SELF: { type: "gadget" },
      } },
    }, {
      FIRST: { type: "deferredGatekeeper", accountId: 3 }, SECOND: { type: "deferredGatekeeper", accountId: 3 },
      RUN: { type: "agentSpawner", modelId: null },
    });
    await runBlueprintSetup(f.restart());
    expect(f.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
    await runBlueprintSetup(f.restart(), { bindingName: "FIRST", gatekeeperId: 81 });
    expect(f.newAgentSpawnerGatekeeper).not.toHaveBeenCalled();
    expect(f.edges.size).toBe(0);
    expect(Object.keys(pendingBlueprintSetup(f.read())!.bindings)).toEqual(["SECOND"]);
    await runBlueprintSetup(f.restart(), { bindingName: "SECOND", gatekeeperId: 82 });
    expect(f.newAgentSpawnerGatekeeper).toHaveBeenCalledExactlyOnceWith({
      displayName: "Runner", modelId: null, env: { API_A: 81, API_B: 82, SELF: 7 },
    });
    expect(Array.from(f.edges)).toEqual([["RUN", 40]]);
    expect(pendingBlueprintSetup(f.read())).toBeNull();
  });

  it("resumes a saved gatekeeper after binding fails without creating it twice", async () => {
    const f = setupFixture({ LEGACY: apiBinding }, { LEGACY: { type: "gatekeeper", accountId: 3, resourceUrl: "https://legacy.test/resource" } });
    f.bind.mockImplementationOnce(() => { throw new Error("TEST_BIND_INTERRUPTED"); });
    await expect(runBlueprintSetup(f.restart())).rejects.toThrow("TEST_BIND_INTERRUPTED");
    expect(f.read().resolved).toEqual({ LEGACY: 40 });
    expect(f.read().bound).toEqual([]);
    await runBlueprintSetup(f.restart());
    expect(f.newGatekeeper).toHaveBeenCalledExactlyOnceWith(3, "https://legacy.test/resource");
    expect(f.edges.get("LEGACY")).toBe(40);
    expect(pendingBlueprintSetup(f.read())).toBeNull();
  });

  it("reopens a removed dependency during partial setup and rebuilds its already-created spawner with the replacement", async () => {
    const f = setupFixture({
      FIRST: { ...apiBinding, spawnerOnly: true }, SECOND: apiBinding,
      RUN: { type: "agentSpawner", title: "Runner", description: "", env: {
        API: { type: "binding", name: "FIRST" }, SELF: { type: "gadget" },
      } },
    }, {
      FIRST: { type: "deferredGatekeeper", accountId: 3 }, SECOND: { type: "deferredGatekeeper", accountId: 3 },
      RUN: { type: "agentSpawner", modelId: null },
    });
    await runBlueprintSetup(f.restart(), { bindingName: "FIRST", gatekeeperId: 81 });
    expect(f.edges.get("RUN")).toBe(40);
    expect(f.newAgentSpawnerGatekeeper).toHaveBeenLastCalledWith({
      displayName: "Runner", modelId: null, env: { API: 81, SELF: 7 },
    });
    f.missing.add(81);
    expect(Object.keys(pendingBlueprintSetup(f.read(), id => f.missing.has(id))!.bindings)).toEqual(["FIRST", "SECOND"]);
    await runBlueprintSetup(f.restart(), { bindingName: "FIRST", gatekeeperId: 82 });
    expect(f.newAgentSpawnerGatekeeper).toHaveBeenCalledTimes(2);
    expect(f.newAgentSpawnerGatekeeper).toHaveBeenLastCalledWith({
      displayName: "Runner", modelId: null, env: { API: 82, SELF: 7 },
    });
    expect(f.bind).toHaveBeenLastCalledWith(7, "RUN", 41, 40);
    expect(f.edges.get("RUN")).toBe(41);
    expect(f.edges.has("FIRST")).toBe(false);
    expect(Object.keys(pendingBlueprintSetup(f.read())!.bindings)).toEqual(["SECOND"]);
    await runBlueprintSetup(f.restart(), { bindingName: "SECOND", gatekeeperId: 83 });
    expect(pendingBlueprintSetup(f.read())).toBeNull();
  });

  it("does not resurrect a deliberately removed connection after setup completed", async () => {
    const f = setupFixture({ SOURCE_API: apiBinding }, { SOURCE_API: { type: "deferredGatekeeper", accountId: 3 } });
    await runBlueprintSetup(f.restart(), { bindingName: "SOURCE_API", gatekeeperId: 81 });
    f.missing.add(81);
    expect(pendingBlueprintSetup(f.read(), id => f.missing.has(id))).toBeNull();
    await runBlueprintSetup(f.restart());
    expect(f.read().resolved).toEqual({ SOURCE_API: 81 });
    expect(f.bind).toHaveBeenCalledOnce();
    expect(f.newGatekeeper).not.toHaveBeenCalled();
  });

  it("preserves empty and AI blueprint setup behavior", async () => {
    const empty = setupFixture({}, {});
    await runBlueprintSetup(empty.restart());
    expect(pendingBlueprintSetup(empty.read())).toBeNull();
    expect(empty.newGatekeeper).not.toHaveBeenCalled();
    const ai = setupFixture({ MODEL: { type: "aiModel", title: "Model", description: "" } }, {
      MODEL: { type: "aiModel", modelId: "chosen-model" },
    });
    await runBlueprintSetup(ai.restart());
    expect(ai.newAiModelGatekeeper).toHaveBeenCalledExactlyOnceWith("chosen-model");
    expect(ai.edges.get("MODEL")).toBe(40);
    expect(pendingBlueprintSetup(ai.read())).toBeNull();
  });

  it("rejects completion under the wrong name or a failed gatekeeper validation without recording progress", async () => {
    const f = setupFixture({ SOURCE_API: apiBinding }, { SOURCE_API: { type: "deferredGatekeeper", accountId: 3 } });
    await expect(runBlueprintSetup(f.restart(), { bindingName: "WRONG", gatekeeperId: 83 })).rejects.toThrow("Unknown deferred blueprint binding.");
    f.validateGatekeeper.mockRejectedValueOnce(new Error("TEST_WRONG_WORKSPACE_BINDING"));
    await expect(runBlueprintSetup(f.restart(), { bindingName: "SOURCE_API", gatekeeperId: 83 })).rejects.toThrow("TEST_WRONG_WORKSPACE_BINDING");
    expect(f.read().resolved).toEqual({});
    expect(f.bind).not.toHaveBeenCalled();
  });
});
