/** Durable blueprint setup keeps workspace-bound configuration separate from source suggestions. */
import type { BlueprintBinding, BlueprintBindingAssignment, Overseer, PendingBlueprintSetup, WorkpieceId } from "@gadgets/workshop-shared/api";
import type { AccountDescription, SupportedResource } from "@gadgets/workshop-shared/gatekeeper";

/** Snapshot of the setup requirement and progress; completed entries make retries idempotent. */
export type BlueprintSetupState = {
  gadgetId: WorkpieceId;
  bindings: Record<string, BlueprintBinding>;
  assignments: Record<string, BlueprintBindingAssignment>;
  resolved: Record<string, WorkpieceId>;
  bound: string[];
  /** Prior setup-owned edges eligible for replacement after a dependency disappears. */
  replacing?: Record<string, WorkpieceId>;
};

/** Validate workspace-bound assignments before allocating a workspace or resolving any draft. */
export async function validateBlueprintAssignments(
  bindings: Record<string, BlueprintBinding>,
  assignments: Record<string, BlueprintBindingAssignment>,
  describeAccount: (id: number) => Promise<{ description: AccountDescription; vendorId: string; supportedResources: SupportedResource[] } | null>,
): Promise<void> {
  for (const [name, assignment] of Object.entries(assignments)) {
    const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;
    if (!binding) throw new Error(`Unknown binding name: ${name}`);
    if (assignment.type !== "gatekeeper" && assignment.type !== "deferredGatekeeper") continue;
    const account = await describeAccount(assignment.accountId);
    if (assignment.type === "gatekeeper") {
      if (account?.description.hostBindingProtocol === "openapi-v1") throw new Error("WORKSPACE_CONTEXT_REQUIRED");
      continue;
    }
    if (binding.type !== "gatekeeper" || account?.description.hostBindingProtocol !== "openapi-v1" ||
        account.vendorId !== binding.gatekeeperName ||
        !account.supportedResources.some(resource => resource.urlPattern === binding.typeUrlPattern)) {
      throw new Error(`Binding "${name}" does not accept this deferred OpenAPI account.`);
    }
  }
  // A deferred dependency cannot be silently dropped from a spawner's environment.
  if (Object.values(assignments).some(assignment => assignment.type === "deferredGatekeeper")) {
    for (const [name, assignment] of Object.entries(assignments)) {
      if (assignment.type !== "agentSpawner") continue;
      const binding = bindings[name];
      if (binding.type !== "agentSpawner") throw new Error(`Binding "${name}" type mismatch.`);
      for (const target of Object.values(binding.env)) {
        if (target.type === "binding" && (!Object.hasOwn(assignments, target.name) || assignments[target.name].type === "agentSpawner")) {
          throw new Error(`Agent spawner binding "${name}" references unassigned resource "${target.name}".`);
        }
      }
    }
  }
}

/** Capture the source metadata without retaining suggestions for another workspace's draft. */
export function createBlueprintSetup(bindings: Record<string, BlueprintBinding>, assignments: Record<string, BlueprintBindingAssignment>, gadgetId: WorkpieceId): BlueprintSetupState {
  const snapshot = structuredClone(bindings);
  for (const binding of Object.values(snapshot)) {
    if (binding.type === "gatekeeper") delete binding.resourceUrl;
  }
  const selected = Object.fromEntries(Object.entries(assignments).map(([name, assignment]) => [name,
    assignment.type === "deferredGatekeeper"
      ? { type: assignment.type, accountId: assignment.accountId }
      : structuredClone(assignment),
  ]));
  return { gadgetId, bindings: snapshot, assignments: selected, resolved: {}, bound: [] };
}

/** Reopen missing dependencies only while setup is unfinished, retaining ownership of old edges. */
export function refreshBlueprintSetup(state: BlueprintSetupState, isMissing: (id: WorkpieceId) => boolean): BlueprintSetupState {
  const next = structuredClone(state);
  if (Object.keys(next.assignments).every(name => next.bound.includes(name))) return next;
  const invalidated = new Set<string>();
  const invalidate = (name: string) => {
    if (!Object.hasOwn(next.resolved, name)) return;
    next.replacing ??= {};
    Object.defineProperty(next.replacing, name, { value: next.resolved[name], enumerable: true, writable: true, configurable: true });
    delete next.resolved[name];
    next.bound = next.bound.filter(bound => bound !== name);
    invalidated.add(name);
  };
  for (const [name, id] of Object.entries(next.resolved)) if (isMissing(id)) invalidate(name);
  for (const [name, binding] of Object.entries(next.bindings)) {
    if (binding.type === "agentSpawner" && Object.values(binding.env).some(target => target.type === "binding" && invalidated.has(target.name))) invalidate(name);
  }
  return next;
}

/** Return unresolved requirements without exposing the rest of the persisted setup manifest. */
export function pendingBlueprintSetup(state: BlueprintSetupState | undefined, isMissing?: (id: WorkpieceId) => boolean): PendingBlueprintSetup | null {
  if (!state) return null;
  if (isMissing) state = refreshBlueprintSetup(state, isMissing);
  const entries = Object.entries(state.assignments);
  if (entries.every(([name]) => state.bound.includes(name))) return null;
  const bindings: PendingBlueprintSetup["bindings"] = {};
  for (const [name, assignment] of entries) {
    const binding = state.bindings[name];
    if (assignment.type === "deferredGatekeeper" && binding.type === "gatekeeper" && !Object.hasOwn(state.resolved, name)) {
      Object.defineProperty(bindings, name, { value: { binding: structuredClone(binding), accountId: assignment.accountId }, enumerable: true });
    }
  }
  return { gadgetId: state.gadgetId, bindings };
}

/** Host operations for the durable setup runner; capability creation reuses the existing APIs. */
export interface BlueprintSetupContext {
  get(): BlueprintSetupState | undefined;
  put(state: BlueprintSetupState): void;
  api: Pick<Overseer, "newGatekeeper" | "newAiModelGatekeeper" | "newAgentSpawnerGatekeeper">;
  assertOwner(): void;
  validateGatekeeper(name: string, id: WorkpieceId): Promise<void>;
  /** Missing or terminally fenced workpieces can be replaced; temporary recovery is not missing. */
  isMissing?(id: WorkpieceId): boolean;
  bind(gadgetId: WorkpieceId, name: string, id: WorkpieceId, replacing?: WorkpieceId): void;
}

/** Advance a serialized setup operation, preserving every resolved ID before binding or spawning. */
export async function runBlueprintSetup(context: BlueprintSetupContext, completion?: { bindingName: string; gatekeeperId: WorkpieceId }): Promise<void> {
  context.assertOwner();
  const initial = context.get();
  if (!initial) {
    if (completion) throw new Error("No pending blueprint setup.");
    return;
  }
  const state = refreshBlueprintSetup(initial, context.isMissing ?? (() => false));
  const save = () => { context.assertOwner(); context.put(state); };
  if (completion) {
    const { bindingName: name, gatekeeperId: id } = completion;
    if (!Object.hasOwn(state.assignments, name) || state.assignments[name].type !== "deferredGatekeeper") throw new Error("Unknown deferred blueprint binding.");
    if (Object.hasOwn(state.resolved, name) && state.resolved[name] !== id) throw new Error("Blueprint binding is already assigned to another connection.");
    await context.validateGatekeeper(name, id);
    context.assertOwner();
    Object.defineProperty(state.resolved, name, { value: id, enumerable: true, writable: true, configurable: true });
    save();
  }
  const bind = (name: string, id: WorkpieceId) => {
    if (state.bound.includes(name)) return;
    context.assertOwner();
    if (!state.bindings[name].spawnerOnly) context.bind(state.gadgetId, name, id, state.replacing?.[name]);
    if (state.replacing) delete state.replacing[name];
    state.bound.push(name);
    save();
  };
  for (const [name, assignment] of Object.entries(state.assignments)) {
    if (assignment.type === "agentSpawner") continue;
    if (!Object.hasOwn(state.resolved, name)) {
      if (assignment.type === "deferredGatekeeper") continue;
      const gatekeeper = assignment.type === "gatekeeper"
        ? await context.api.newGatekeeper(assignment.accountId, assignment.resourceUrl)
        : await context.api.newAiModelGatekeeper(assignment.modelId);
      if (!gatekeeper) throw new Error(`Failed to create gatekeeper for binding "${name}".`);
      let id: WorkpieceId;
      try { id = await gatekeeper.getId(); }
      finally {
        // Local implementations are RpcTargets; native RPC results also own disposable stubs.
        if (Symbol.dispose in gatekeeper) {
          const dispose = gatekeeper[Symbol.dispose];
          if (typeof dispose === "function") dispose.call(gatekeeper);
        }
      }
      context.assertOwner();
      Object.defineProperty(state.resolved, name, { value: id, enumerable: true, writable: true, configurable: true });
      save();
    }
    bind(name, state.resolved[name]);
  }
  for (const [name, assignment] of Object.entries(state.assignments)) {
    if (assignment.type !== "agentSpawner") continue;
    const binding = state.bindings[name];
    if (binding.type !== "agentSpawner") throw new Error(`Binding "${name}" type mismatch.`);
    if (!Object.hasOwn(state.resolved, name)) {
      if (Object.values(binding.env).some(target => target.type === "binding" && !Object.hasOwn(state.resolved, target.name))) continue;
      const env = Object.fromEntries(Object.entries(binding.env).map(([envName, target]) => [envName, target.type === "gadget" ? state.gadgetId : state.resolved[target.name]]));
      const gatekeeper = await context.api.newAgentSpawnerGatekeeper({ displayName: binding.title, modelId: assignment.modelId, env });
      let id: WorkpieceId;
      try { id = await gatekeeper.getId(); }
      finally {
        // Local implementations are RpcTargets; native RPC results also own disposable stubs.
        if (Symbol.dispose in gatekeeper) {
          const dispose = gatekeeper[Symbol.dispose];
          if (typeof dispose === "function") dispose.call(gatekeeper);
        }
      }
      context.assertOwner();
      Object.defineProperty(state.resolved, name, { value: id, enumerable: true, writable: true, configurable: true });
      save();
    }
    bind(name, state.resolved[name]);
  }
}
