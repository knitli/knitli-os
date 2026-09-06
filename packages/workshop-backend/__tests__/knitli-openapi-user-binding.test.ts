import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user";
import type { OverseerDurableObject } from "../src/overseer";
import type { OpenApiAccountTest, OpenApiAccountTestControl } from "./fork-fixtures/openapi-account-worker";
import { env, RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  BoundIdentity,
  DraftReference,
  HostDraftAuthority,
} from "@gadgets/workshop-shared/fork/openapi-host-binding";
import type { GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import {
  createOpenApiUserBinding,
  type OpenApiAccountEpoch,
  type OpenApiAccountCleanup,
  type OpenApiDraftCleanupReceipt,
  type OpenApiWorkspaceRetirement,
  type OpenApiUserBindingContext,
} from "../src/fork/openapi-user-binding";
import type { BindingRow } from "../src/fork/openapi-binding-ledger";
declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
    TEST_OPENAPI_ACCOUNT_CONTROL: DurableObjectNamespace<OpenApiAccountTestControl>;
  }
}
const url = "https://workshop.test/gatekeeper/openapi/apis/api/releases/v1.0/grants/grant";
const pattern = "https://workshop.test/gatekeeper/openapi/apis/*";
const reference: DraftReference = { draftId: "draft", grantId: "grant", selectionDigest: "digest" };
const noPause = async () => {};
function fixture(v1 = true) {
  const rows = new Map<string, BindingRow>();
  const epochs = new Map<number, OpenApiAccountEpoch>();
  const issuers = new Map<string, string>();
  const cleanup = new Map<string, OpenApiAccountCleanup>();
  const receipts = new Map<string, OpenApiDraftCleanupReceipt>();
  const retirements = new Map<string, OpenApiWorkspaceRetirement>();
  const recipients: { incarnation: string; workspaceId: string; drafts: DraftReference[] }[] = [];
  const cleanupResolves: DraftReference[] = [];
  let recipientPause: (workspaceId: string) => Promise<void> = noPause;
  let scheduled = 0;
  const authorities: HostDraftAuthority[] = [];
  const calls: {
    legacy: unknown[][];
    bound: unknown[][];
    resolve: DraftReference[];
    activate: number;
    disposed: number;
  } = { legacy: [], bound: [], resolve: [], activate: 0, disposed: 0 };
  let clock = 1000;
  let resolvePause = noPause;
  let revokePause = noPause;
  let policyPause = noPause;
  const ui = new (class extends RpcTarget {})();
  const finalizer = new (class extends RpcTarget {
    async activate() {
      calls.activate++;
    }
    async revoke() { await revokePause(); }
    [Symbol.dispose]() {
      calls.disposed++;
    }
  })();
  const frame = { iframeHtml: "<p>selection</p>", ui };
  const account = new (class extends RpcTarget {
    async startResourceConfigurator(...args: unknown[]) {
      calls.legacy.push(args);
      return frame;
    }
    async startBoundResourceConfigurator(p: string, authority: HostDraftAuthority) {
      calls.bound.push([p, authority]);
      authorities.push(authority);
      return frame;
    }
    async resolveBoundDraftForRevocation(ref: DraftReference) {
      cleanupResolves.push(ref);
      return finalizer;
    }
    async resolveBoundDraft(ref: DraftReference) {
      calls.resolve.push(ref);
      await resolvePause();
      return {
        class: {},
        resource: { title: "API", description: "API", urlPattern: pattern },
        resourceUrl: url,
        finalizer,
      };
    }
  })();
  const context: OpenApiUserBindingContext = {
    transaction: (operation) => operation(),
    ownerId: "owner",
    publicBaseUrl: "https://workshop.test/",
    store: {
      get: (id) => rows.get(id),
      put: (id, row) => {
        rows.set(id, row);
      },
      list: () => [...rows.values()],
    },
    getAccount: (id) =>
      id === 0
        ? {
            account: account as unknown as Fetcher<GatekeeperUser>,
            description: {
              displayName: "API",
              ...(v1 ? { hostBindingProtocol: "openapi-v1" as const } : {}),
            },
            vendorId: "openapi",
          }
        : undefined,
    getDraftIssuer: (id) => issuers.get(id),
    putDraftIssuer: (id, issuer) => {
      issuers.set(id, issuer);
    },
    cleanup: {
      get: id => cleanup.get(id),
      put: record => { cleanup.set(record.incarnation, record); },
      delete: id => { cleanup.delete(id); },
      list: () => [...cleanup.values()],
    },
    receipts: {
      get: id => receipts.get(id),
      put: receipt => { receipts.set(receipt.reference.draftId, receipt); },
    },
    retirements: {
      get: id => retirements.get(id),
      put: retirement => { retirements.set(retirement.workspaceId, retirement); },
      list: () => [...retirements.values()],
    },
    scheduleCleanup: () => { scheduled++; },
    revokeRecipient: async (record, workspaceId, drafts) => {
      recipients.push({ incarnation: record.incarnation, workspaceId, drafts });
      await recipientPause(workspaceId);
    },
    getEpoch: (id) => epochs.get(id),
    putEpoch: (epoch) => {
      epochs.set(epoch.id, epoch);
    },
    checkPolicy: async () => {
      await policyPause();
    },
    now: () => clock,
  };
  const restart = () => createOpenApiUserBinding(context);
  const binding = restart();
  async function register() {
    await binding.start(0, pattern, "workspace");
    await authorities.at(-1)!.registerDraft(reference);
  }
  const identity = (): BoundIdentity => ({
    ...reference,
    ownerId: "owner",
    providerAccountId: 0,
    accountIncarnation: epochs.get(0)!.incarnation,
    workspaceId: "workspace",
    gatekeeperId: 0,
    facetName: "gatekeeper0",
    generation: 1,
  });
  return {
    binding,
    cleanup,
    receipts,
    retirements,
    recipients,
    cleanupResolves,
    scheduled: () => scheduled,
    pauseRevoke: (pause: () => Promise<void>) => { revokePause = pause; },
    pauseRecipient: (pause: (workspaceId: string) => Promise<void>) => { recipientPause = pause; },
    restart,
    context,
    rows,
    epochs,
    authorities,
    calls,
    frame,
    register,
    identity,
    expire: () => {
      clock += 900_000;
    },
    pauseResolve: (pause: () => Promise<void>) => {
      resolvePause = pause;
    },
    pausePolicy: (pause: () => Promise<void>) => {
      policyPause = pause;
    },
  };
}
describe("private authenticated User draft authority", () => {
  it("preserves legacy RPC arity and never materializes private authority", async () => {
    const f = fixture(false);
    expect(await f.binding.start(0, pattern)).toBe(f.frame);
    expect(f.calls.legacy).toEqual([[pattern]]);
    expect(f.calls.bound).toEqual([]);
    expect(f.epochs.size).toBe(0);
  });
  it("requires workspace context and passes only the private authority to v1", async () => {
    const f = fixture();
    await expect(f.binding.start(0, pattern)).rejects.toThrow("WORKSPACE_CONTEXT_REQUIRED");
    await f.register();
    expect(f.calls.legacy).toEqual([]);
    expect(f.calls.bound).toEqual([[pattern, f.authorities[0]]]);
    expect(f.authorities[0]).toBeInstanceOf(RpcTarget);
    expect(Reflect.ownKeys(f.frame)).toEqual(["iframeHtml", "ui"]);
    expect("registerDraft" in f.frame.ui).toBe(false);
    expect(f.rows.get("draft")!.intendedWorkspaceId).toBe("workspace");
  });
  it("retains immutable reference and expiry on exact retry, rejecting grant ambiguity", async () => {
    const f = fixture();
    await f.register();
    const original = f.rows.get("draft")!;
    expect(await f.authorities[0].registerDraft(reference)).toEqual({
      expiresAt: original.expiresAt,
    });
    await expect(
      f.authorities[0].registerDraft({ ...reference, selectionDigest: "other" }),
    ).rejects.toThrow("DRAFT_CONFLICT");
    await expect(
      f.authorities[0].registerDraft({ ...reference, draftId: "other" }),
    ).rejects.toThrow("DRAFT_CONFLICT");
    expect(f.rows.size).toBe(1);
  });
  it("limits cancellation to references registered by this authority", async () => {
    const f = fixture();
    await f.register();
    await f.binding.start(0, pattern, "workspace");
    await expect(f.authorities[1].cancelDraft("draft")).rejects.toThrow("DRAFT_NOT_FOUND");
    await expect(f.authorities[1].registerDraft(reference)).rejects.toThrow("DRAFT_CONFLICT");
    await expect(f.authorities[1].cancelDraft("draft")).rejects.toThrow("DRAFT_NOT_FOUND");
    expect(f.rows.get("draft")!.state).toBe("draft");
    await f.authorities[0].cancelDraft("draft");
    await f.authorities[0].cancelDraft("draft");
    await expect(f.binding.lookup(0, url, "workspace")).rejects.toThrow("BINDING_REVOKED");
    expect(f.calls.resolve).toEqual([]);
  });
  it.each([
    "ownerId",
    "workspaceId",
    "accountIncarnation",
    "providerAccountId",
    "selectionDigest",
  ] as const)("rejects substituted %s before reservation", async (field) => {
    const f = fixture();
    await f.register();
    const id = f.identity();
    const invalid = { ...id, [field]: field === "providerAccountId" ? 1 : "other" };
    expect(() => f.binding.reserve(invalid)).toThrow(
      field === "providerAccountId"
        ? "BINDING_ACCOUNT_UNAVAILABLE"
        : field === "accountIncarnation"
          ? "BINDING_ACCOUNT_REPLACED"
          : "BINDING_IDENTITY_MISMATCH",
    );
    expect(f.rows.get("draft")!.state).toBe("draft");
    expect(f.calls.activate).toBe(0);
    expect(f.binding.reserve(id).state).toBe("reserved");
  });
  it("readiness cannot reserve a draft", async () => {
    const f = fixture();
    await f.register();
    expect(() => f.binding.assertReady(f.identity())).toThrow("BINDING_IDENTITY_MISMATCH");
    expect(f.rows.get("draft")!.state).toBe("draft");
  });
  it("resolves only registered account/workspace locators", async () => {
    const f = fixture();
    await f.register();
    await expect(
      f.binding.lookup(0, url.replace("/grants/grant", "/grants/absent"), "workspace"),
    ).rejects.toThrow("DRAFT_NOT_FOUND");
    await expect(f.binding.lookup(1, url, "workspace")).rejects.toThrow(
      "BINDING_ACCOUNT_UNAVAILABLE",
    );
    await expect(f.binding.lookup(0, url, "other")).rejects.toThrow("DRAFT_NOT_FOUND");
    expect(f.calls.resolve).toEqual([]);
    const result = await f.binding.lookup(0, url, "workspace");
    expect(result.row.reference).toEqual(reference);
    expect(f.calls.resolve).toEqual([reference]);
  });
  it.each(["?extra=1", "#fragment", "/extra"])(
    "rejects unused locator syntax %s before connector resolution",
    async (suffix) => {
      const f = fixture();
      await f.register();
      await expect(f.binding.lookup(0, url + suffix, "workspace")).rejects.toThrow(
        "BINDING_INVALID_LOCATOR",
      );
      expect(f.calls.resolve).toEqual([]);
    },
  );
  it.each(["/apis/api", "/releases/v1.0"])(
    "rejects changed %s with the same grant before activation",
    async (segment) => {
      const f = fixture();
      await f.register();
      await expect(
        f.binding.lookup(0, url.replace(segment, segment + "-other"), "workspace"),
      ).rejects.toThrow("BINDING_RESOURCE_URL_MISMATCH");
      expect(f.calls.resolve).toEqual([reference]);
      expect(f.calls.activate).toBe(0);
      expect(f.rows.get("draft")!.state).toBe("draft");
      expect(f.calls.disposed).toBe(1);
    },
  );
  it("rejects foreign origin before private resolution", async () => {
    const f = fixture();
    await f.register();
    await expect(
      f.binding.lookup(0, url.replace("workshop.test", "attacker.test"), "workspace"),
    ).rejects.toThrow("BINDING_INVALID_LOCATOR");
    expect(f.calls.resolve).toEqual([]);
  });
  it("expires unactivated drafts but preserves active bindings across restart", async () => {
    const f = fixture();
    await f.register();
    f.binding.reserve(f.identity());
    f.binding.beginActivation(f.identity());
    f.binding.activate(f.identity(), reference.selectionDigest);
    f.expire();
    await expect(f.restart().lookup(0, url, "workspace")).resolves.toMatchObject({
      row: { state: "active" },
    });
    const g = fixture();
    await g.register();
    g.expire();
    await expect(g.binding.lookup(0, url, "workspace")).rejects.toThrow("DRAFT_EXPIRED");
    expect(g.calls.resolve).toEqual([]);
  });
  it("fences an account even before its first v1 operation", async () => {
    const f = fixture();
    f.binding.fence(0);
    await expect(f.binding.start(0, pattern, "workspace")).rejects.toThrow(
      "BINDING_ACCOUNT_REPLACED",
    );
    expect(f.calls.bound).toEqual([]);
  });
  it("never revives stale authorities after replacement or restart", async () => {
    const f = fixture();
    await f.register();
    const old = f.identity();
    f.binding.fence(0);
    f.binding.replace(0);
    await expect(f.authorities[0].registerDraft(reference)).rejects.toThrow(
      "BINDING_ACCOUNT_REPLACED",
    );
    expect(() => f.restart().reserve(old)).toThrow("BINDING_ACCOUNT_REPLACED");
    await expect(f.restart().lookup(0, url, "workspace")).rejects.toThrow("DRAFT_NOT_FOUND");
    expect(f.calls.resolve).toEqual([]);
  });
  it.each(["disconnect", "replacement"])(
    "a delayed %s cannot mutate a newer account lifecycle",
    async (operation) => {
      const f = fixture();
      await f.register();
      let release!: () => void;
      let committed = false;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const mutation = f.binding.mutateAccount(
        0,
        () => paused,
        () => {
          committed = true;
          if (operation === "replacement") f.binding.replace(0);
        },
      );
      await expect(f.authorities[0].registerDraft(reference)).rejects.toThrow(
        "BINDING_ACCOUNT_REPLACED",
      );
      // A later disconnect stays fenced; a later replacement remains the current incarnation.
      f.binding.fence(0);
      if (operation === "disconnect") f.binding.replace(0);
      const successor = { ...f.epochs.get(0)! };
      release();
      await expect(mutation).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
      expect(committed).toBe(false);
      expect(f.epochs.get(0)).toEqual(successor);
    },
  );
  it("provider failure leaves account authority fenced without committing removal", async () => {
    const f = fixture();
    await f.register();
    let committed = false;
    await expect(
      f.binding.mutateAccount(
        0,
        async () => {
          throw new Error("provider refused revoke");
        },
        () => {
          committed = true;
        },
      ),
    ).rejects.toThrow("provider refused revoke");
    expect(committed).toBe(false);
    expect(f.recipients).toHaveLength(1);
    expect(f.cleanup.size).toBe(0);
    expect(f.rows.get("draft")?.state).toBe("revoked");
    await expect(f.restart().start(0, pattern, "workspace")).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
    await expect(f.binding.start(0, pattern, "workspace")).rejects.toThrow(
      "BINDING_ACCOUNT_REPLACED",
    );
  });
  it("legacy account cleanup retains its callback behavior", async () => {
    const f = fixture(false);
    let committed = false;
    await f.binding.mutateAccount(
      0,
      async () => {},
      () => {
        committed = true;
      },
    );
    expect(committed).toBe(true);
    expect(f.epochs.size).toBe(0);
  });
  it.each(["resolve", "policy"])("rechecks replacement after the %s await", async (boundary) => {
    const f = fixture();
    await f.register();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = async () => {
      entered();
      await paused;
    };
    if (boundary === "resolve") f.pauseResolve(pause);
    else f.pausePolicy(pause);
    const lookup = f.binding.lookup(0, url, "workspace");
    await started;
    f.binding.fence(0);
    f.binding.replace(0);
    release();
    await expect(lookup).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
    expect(f.calls.activate).toBe(0);
    expect(f.calls.disposed).toBe(1);
  });
});

describe("actual User DO lifecycle hooks", () => {
  it.each(["disconnect", "login-replacement"])(
    "a paused %s cannot delete or resurrect a successor",
    async (operation) => {
      const stub = env.TEST_USER.getByName(crypto.randomUUID());
      await runInDurableObject(stub, async (user: UserDurableObject) => {
        const storage = user["storage"];
        const accounts = storage.connectedAccounts;
        type AccountRecord = NonNullable<ReturnType<typeof accounts.get>>;
        let release!: () => void;
        let entered!: () => void;
        const paused = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const description = {
          displayName: "API",
          avatar: { url: "https://workshop.test/avatar" },
          uniqueName: "same-account",
          hostBindingProtocol: "openapi-v1" as const,
        };
        let secondEntered!: () => void;
        const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
        let revokeCalls = 0;
        const oldAccount = new (class extends RpcTarget {
          async describe() {
            return description;
          }
          async revoke() {
            revokeCalls++;
            if (revokeCalls === 2) secondEntered();
            entered();
            await paused;
          }
        })();
        const newAccount = new (class extends RpcTarget {
          async describe() {
            return description;
          }
          async revoke() {}
        })();
        let record: AccountRecord | undefined = {
          id: 0,
          account: oldAccount as unknown as AccountRecord["account"],
          description,
          vendorId: "openapi",
        };
        const get = vi
          .spyOn(accounts, "get")
          .mockImplementation((id) => (id === 0 ? record : undefined));
        const put = vi.spyOn(accounts, "put").mockImplementation((value) => {
          record = value;
        });
        const remove = vi.spyOn(accounts, "delete").mockImplementation(() => {
          record = undefined;
        });
        storage.nextAccountId.put(1);
        try {
          const first =
            operation === "disconnect"
              ? user.disconnectAccount(0)
              : user.linkConnectedAccountFromLogin(
                  newAccount as unknown as AccountRecord["account"],
                  "openapi",
                );
          await started;
          const fenced = storage.openApiAccountEpochs.get(0)!;
          expect(fenced.live).toBe(false);
          expect(revokeCalls).toBe(1);
          expect(get).toHaveBeenCalled();
          if (operation === "disconnect") {
            const successor: AccountRecord = {
              id: 0,
              account: newAccount as unknown as AccountRecord["account"],
              description,
              vendorId: "openapi",
            };
            await user.putConnectedAccount(successor);
            const successorEpoch = storage.openApiAccountEpochs.get(0)!;
            expect(successorEpoch.live).toBe(true);
            expect(successorEpoch.incarnation).not.toBe(fenced.incarnation);
            release();
            await expect(first).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
            expect(record?.account).toBe(newAccount);
            expect(remove).not.toHaveBeenCalled();
            expect(storage.openApiAccountEpochs.get(0)).toEqual(successorEpoch);
          } else {
            const disconnect = user.disconnectAccount(0);
            await secondStarted;
            expect(revokeCalls).toBe(2);
            release();
            await expect(first).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
            await disconnect;
            expect(record).toBeUndefined();
            expect(put).not.toHaveBeenCalled();
            expect(remove).toHaveBeenCalledOnce();
            expect(storage.openApiAccountEpochs.get(0)!.live).toBe(false);
          }
        } finally {
          release();
          get.mockRestore();
          put.mockRestore();
          remove.mockRestore();
        }
      });
    },
  );
});


describe("account cleanup recipients and historical authority", () => {
  it("persists every registered workspace before provider await and waits for recipient fences", async () => {
    const f = fixture();
    await f.register();
    await f.binding.start(0, pattern, "unreserved-workspace");
    const second = {...reference, draftId: "second", grantId: "second-grant"};
    await f.authorities.at(-1)!.registerDraft(second);
    const incarnation = f.identity().accountIncarnation;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.pauseRecipient(async workspace => {
      if (workspace === "unreserved-workspace") { entered(); await barrier; }
    });
    let committed = false;
    const mutation = f.binding.mutateAccount(0, async () => {
      expect(f.cleanup.size).toBe(0);
      expect(f.epochs.get(0)?.live).toBe(false);
      expect(f.rows.get("second")?.state).toBe("revoked");
      expect(f.scheduled()).toBeGreaterThan(0);
    }, () => { committed = true; });
    await Promise.race([started, mutation]);
    expect(committed).toBe(false);
    expect(f.recipients).toEqual(expect.arrayContaining([
      {incarnation, workspaceId: "unreserved-workspace", drafts: [second]},
    ]));
    release();
    await mutation;
    expect(committed).toBe(true);
    expect(f.cleanup.size).toBe(0);
    expect(f.rows.get("second")?.state).toBe("revoked");
  });

  it("keeps an unreachable recipient durable across adapter restart and preserves the successor", async () => {
    const f = fixture();
    await f.register();
    const old = structuredClone(f.rows.get("draft")!);
    f.pauseRecipient(async () => { throw new Error("recipient unavailable"); });
    let committed = false;
    const operation = vi.fn(noPause);
    await expect(f.binding.mutateAccount(0, operation, () => { committed = true; }))
      .rejects.toThrow("recipient unavailable");
    expect(operation).not.toHaveBeenCalled();
    expect(committed).toBe(false);
    expect(f.cleanup.get(old.accountIncarnation)?.recipients).toHaveLength(1);
    f.binding.replace(0);
    const successor = {...f.epochs.get(0)!};
    await expect(f.restart().resolveForRevocation(old)).resolves.toHaveProperty("finalizer");
    expect(f.cleanupResolves).toEqual([reference]);
    expect(f.calls.resolve).toEqual([]);
    await expect(f.restart().lookup(0, url, "workspace")).rejects.toThrow("DRAFT_NOT_FOUND");
    f.pauseRecipient(noPause);
    await f.restart().drainCleanup();
    expect(f.cleanup.size).toBe(0);
    expect(f.epochs.get(0)).toEqual(successor);
    expect(f.rows.get("draft")?.state).toBe("revoked");
  });

  it.each(["ownerId", "providerAccountId", "accountIncarnation", "intendedWorkspaceId", "grantId", "selectionDigest"])(
    "rejects substituted cleanup %s before resolving any provider capability", async field => {
      const f = fixture();
      await f.register();
      const row = structuredClone(f.rows.get("draft")!);
      f.binding.fence(0);
      const changed = field === "grantId" || field === "selectionDigest"
        ? {...row, reference: {...row.reference, [field]: "forged"}}
        : {...row, [field]: field === "providerAccountId" ? 99 : "forged"};
      await expect(f.restart().resolveForRevocation(changed)).rejects.toThrow("BINDING_IDENTITY_MISMATCH");
      expect(f.cleanupResolves).toEqual([]);
    },
  );
});

describe("actual User shared resource policy", () => {
  it.each(["legacy", "openapi"] as const)("%s enforces fresh vendor and resource policy after resolution", async route => {
    const stub = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      const accounts = user["storage"].connectedAccounts;
      type AccountRecord = NonNullable<ReturnType<typeof accounts.get>>;
      const resourceUrl = url;
      const resource = {title: "API", description: "API", urlPattern: resourceUrl};
      let policy = {};
      const events: string[] = [];
      const finalizer = new (class extends RpcTarget { [Symbol.dispose]() {} })();
      const resolve = vi.fn(async () => {
        events.push("provider");
        return {class: {}, resource, resourceUrl, finalizer};
      });
      const account = new (class extends RpcTarget {
        getGatekeeperClassFor = resolve;
        resolveBoundDraft = resolve;
        async startBoundResourceConfigurator(_pattern: string, authority: HostDraftAuthority) {
          await authority.registerDraft(reference);
          return {iframeHtml: "<p>Configured</p>"};
        }
      })();
      const get = vi.spyOn(accounts, "get").mockReturnValue({
        id: 0, vendorId: "OpenAPI", account: account as unknown as AccountRecord["account"],
        description: {displayName: "API", avatar: {url: "https://workshop.test/avatar"},
          ...(route === "openapi" ? {hostBindingProtocol: "openapi-v1" as const} : {})},
      });
      const readPolicy = vi.fn(async (key: string) => {
        expect(key).toBe(".adminConfig");
        events.push("policy");
        return JSON.stringify(policy);
      });
      const originalEnv = user["env"];
      user["env"] = {...originalEnv, PUBLIC_BASE_URL: "https://workshop.test/",
        BLUEPRINTS: {get: readPolicy} as unknown as KVNamespace};
      const lookup = () => route === "legacy"
        ? user.getGatekeeperClassFor(0, resourceUrl)
        : user.lookupOpenApiDraft(0, resourceUrl, "workspace");
      try {
        if (route === "openapi") await user.startBoundResourceConfigurator(0, resourceUrl, "workspace");
        await expect(lookup()).resolves.toHaveProperty("typeUrlPattern", resourceUrl);
        policy = {disabledGatekeepers: ["openapi"]};
        await expect(lookup()).rejects.toThrow('The "OpenAPI" gatekeeper is disabled on this deployment by an administrator.');
        policy = {disabledResources: {openapi: [resourceUrl]}};
        await expect(lookup()).rejects.toThrow('The "API" resource is disabled on this deployment by an administrator.');
        policy = {};
        await expect(lookup()).resolves.toHaveProperty("typeUrlPattern", resourceUrl);
        expect(resolve).toHaveBeenCalledTimes(4);
        expect(readPolicy).toHaveBeenCalledTimes(4);
        expect(events).toEqual(Array.from({length: 4}, () => ["provider", "policy"]).flat());
      } finally { get.mockRestore(); user["env"] = originalEnv; }
    });
  });
});

describe("actual User legacy resolver guard", () => {
  it.each([true, false])("v1=%s routes only through the permitted resolver", async v1 => {
    const stub = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      const accounts = user["storage"].connectedAccounts;
      type AccountRecord = NonNullable<ReturnType<typeof accounts.get>>;
      const legacy = vi.fn(async () => { throw new Error("legacy resolver reached"); });
      const account = new (class extends RpcTarget { getGatekeeperClassFor = legacy; })();
      const get = vi.spyOn(accounts, "get").mockReturnValue({
        id: 0, vendorId: "openapi", account: account as unknown as AccountRecord["account"],
        description: {displayName: "API", avatar: {url: "https://workshop.test/avatar"},
          ...(v1 ? {hostBindingProtocol: "openapi-v1" as const} : {})},
      });
      try {
        await expect(user.getGatekeeperClassFor(0, url)).rejects.toThrow(
          v1 ? "WORKSPACE_CONTEXT_REQUIRED" : "legacy resolver reached");
        expect(legacy).toHaveBeenCalledTimes(v1 ? 0 : 1);
        if (!v1) expect(legacy).toHaveBeenCalledWith(url);
      } finally { get.mockRestore(); }
    });
  });
});


async function durableCleanupFixture() {
  const name = crypto.randomUUID();
  const user = env.TEST_USER.getByName(name);
  const workspace = env.TEST_OVERSEER.getByName(name);
  const control = env.TEST_OPENAPI_ACCOUNT_CONTROL.getByName(name);
  await runInDurableObject(workspace, instance => {
    instance["impl"].storage.ownerId.put(user.id.toString());
    instance["impl"].ownerId = user.id.toString();
  });
  await runInDurableObject(user, async instance => {
    const exports = instance["ctx"].exports as Cloudflare.Exports & {
      OpenApiAccountTest: LoopbackForExport<typeof OpenApiAccountTest>;
    };
    const account = exports.OpenApiAccountTest({props: {controlId: control.id.toString(), reference}}) as unknown as Fetcher<GatekeeperUser>;
    const description = await account.describe();
    instance["storage"].connectedAccounts.put({id: 0, account, description, vendorId: "openapi"});
    instance["storage"].nextAccountId.put(1);
    await instance.startBoundResourceConfigurator(0, pattern, workspace.id.toString());
  });
  const inspect = () => runInDurableObject(user, instance => ({
    pending: Array.from(instance["storage"].openApiAccountCleanup.list()).map(item => ({
      incarnation: item.incarnation, recipients: item.recipients,
    })),
    epoch: instance["storage"].openApiAccountEpochs.get(0),
    connected: Boolean(instance["storage"].connectedAccounts.get(0)),
    row: instance["storage"].openApiDrafts.get(reference.draftId),
  }));
  return {user, workspace, control, inspect};
}

describe("actual User durable account cleanup", () => {
  it("fences actual recipient workspace before provider revoke and waits for connector acknowledgement", async () => {
    const f = await durableCleanupFixture();
    await f.control.pause("provider");
    await f.control.pause("cleanup");
    let completed = false;
    const disconnect = f.user.disconnectAccount(0).then(() => { completed = true; });
    try {
      // Race entry events so the former order fails an assertion, not a timeout.
      const first = await Promise.race([
        f.control.waitEntered("provider").then(() => "provider"),
        f.control.waitEntered("cleanup").then(() => "cleanup"),
      ]);
      expect(first).toBe("cleanup");
      const fenced = await f.inspect();
      expect(fenced.epoch?.live).toBe(false);
      expect(fenced.row?.identity).toBeUndefined();
      expect(fenced.pending[0]?.recipients).toEqual([
        {workspaceId: f.workspace.id.toString(), drafts: [reference]},
      ]);
      expect(completed).toBe(false);
      await runInDurableObject(f.workspace, instance => {
        expect(instance["impl"].storage.openApiAccountFences.get(fenced.row!.accountIncarnation))
          .toMatchObject({drafts: [{reference, revoked: false}]});
      });
      expect((await f.control.events()).provider).toBe(0);
      expect(completed).toBe(false);
      expect((await f.inspect()).pending).toHaveLength(1);
      await f.control.release("cleanup");
      await f.control.waitEntered("provider");
      expect((await f.inspect()).pending).toEqual([]);
      expect(completed).toBe(false);
      await f.control.release("provider");
      await disconnect;
      expect(completed).toBe(true);
      expect(await f.inspect()).toMatchObject({pending: [], connected: false, row: {state: "revoked"}});
      expect((await f.control.events()).resolved).toEqual([reference]);
    } finally {
      await f.control.release("provider");
      await f.control.release("cleanup");
      await disconnect;
    }
  });

  it("retries failed cleanup after real User eviction using retained account capability", async () => {
    const f = await durableCleanupFixture();
    await runInDurableObject(f.user, async instance => {
      const recipient = vi.spyOn(instance["ctx"].exports.OverseerDurableObject, "get")
        .mockImplementation(() => { throw new Error("test recipient unavailable"); });
      try {
        await expect(instance.disconnectAccount(0)).rejects.toThrow("test recipient unavailable");
        expect(recipient).toHaveBeenCalledOnce();
      } finally { recipient.mockRestore(); }
    });
    expect((await f.control.events()).provider).toBe(0);
    const failed = await f.inspect();
    expect(failed.pending).toHaveLength(1);
    expect(failed.epoch?.live).toBe(false);
    expect(failed.row?.state).toBe("revoking");
    await evictDurableObject(f.user);
    expect((await f.inspect()).pending).toEqual(failed.pending);
    expect(await runDurableObjectAlarm(f.user)).toBe(true);
    expect(await f.inspect()).toMatchObject({pending: [], epoch: failed.epoch, row: {state: "revoked"}});
    expect((await f.control.events()).resolved).toEqual([reference]);
  });

  it("late cleanup from a superseded disconnect never deletes the successor account", async () => {
    const f = await durableCleanupFixture();
    await runInDurableObject(f.user, async instance => {
      const controls = (instance["ctx"].exports as Cloudflare.Exports & {
        OpenApiAccountTestControl: DurableObjectNamespace<OpenApiAccountTestControl>;
      }).OpenApiAccountTestControl;
      const control = controls.get(controls.idFromString(f.control.id.toString()));
      await control.pause("provider");
      const first = instance.disconnectAccount(0);
      const rejected = expect(first).rejects.toThrow("BINDING_ACCOUNT_REPLACED");
      try {
        await control.waitEntered("provider");
        await instance.putConnectedAccount(instance["storage"].connectedAccounts.get(0)!);
        const successor = instance["storage"].openApiAccountEpochs.get(0)!;
        expect(successor.live).toBe(true);
        await control.release("provider");
        await rejected;
        expect(instance["storage"].connectedAccounts.get(0)).toBeDefined();
        expect(instance["storage"].openApiAccountEpochs.get(0)).toEqual(successor);
        expect(Array.from(instance["storage"].openApiAccountCleanup.list())).toEqual([]);
      } finally { await control.release("provider"); }
    });
  });
});


describe("durable workspace retirement", () => {
  it("fences issuance and reservation before revoke, preserving another workspace", async () => {
    const f = fixture();
    await f.register();
    await f.binding.start(0, pattern, "workspace");
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.pauseRevoke(async () => { entered(); await barrier; });
    const retirement = f.binding.retireWorkspace("workspace");
    try {
      await Promise.race([started, retirement]);
      const late = {...reference, draftId: "late", grantId: "late-grant"};
      await expect(f.authorities[1].registerDraft(late)).rejects.toThrow("BINDING_WORKSPACE_CLOSED");
      expect(f.rows.size).toBe(1);
      expect(f.retirements.get("workspace")?.drafts).toHaveLength(1);
      await expect(f.binding.start(0, pattern, "workspace")).rejects.toThrow("BINDING_WORKSPACE_CLOSED");
      await expect(f.binding.lookup(0, url, "workspace")).rejects.toThrow("BINDING_WORKSPACE_CLOSED");
      expect(() => f.binding.reserve(f.identity())).toThrow("BINDING_WORKSPACE_CLOSED");
      expect(f.receipts.size).toBe(0);
      const other = {...reference, draftId: "other", grantId: "other-grant"};
      await f.binding.start(0, pattern, "other-workspace");
      await f.authorities.at(-1)!.registerDraft(other);
      expect(f.binding.reserve({...f.identity(), ...other, workspaceId: "other-workspace"}).state).toBe("reserved");
      expect(f.epochs.get(0)?.live).toBe(true);
    } finally { release(); }
    await retirement;
    expect(f.receipts.get("draft")).toMatchObject({intendedWorkspaceId: "workspace", reference});
    await f.binding.mutateAccount(0, noPause, () => {});
    expect(f.recipients.map(recipient => recipient.workspaceId)).toEqual(["other-workspace"]);
  });

  it("keeps failed revoker cleanup pending across restart and later skips only its exact receipt", async () => {
    const f = fixture();
    await f.register();
    f.pauseRevoke(async () => { throw new Error("retirement revoke unavailable"); });
    await expect(f.binding.retireWorkspace("workspace")).rejects.toThrow("retirement revoke unavailable");
    expect(f.receipts.size).toBe(0);
    expect(f.restart().hasPendingRetirements()).toBe(true);
    await expect(f.restart().start(0, pattern, "workspace")).rejects.toThrow("BINDING_WORKSPACE_CLOSED");
    f.pauseRevoke(noPause);
    await f.restart().drainWorkspaceRetirements();
    expect(f.restart().hasPendingRetirements()).toBe(false);
    expect(f.receipts.get("draft")?.reference).toEqual(reference);
    await f.restart().mutateAccount(0, noPause, () => {});
    expect(f.recipients).toEqual([]);
    using proof = (await f.restart().resolveForRevocation(f.rows.get("draft")!)).finalizer;
    await proof.revoke("removed");
    expect(f.cleanupResolves).toEqual([reference, reference]);
  });

  it("retires with an archived account and discharges already-pending fanout without deleting a successor", async () => {
    const f = fixture();
    await f.register();
    f.pauseRecipient(async () => { throw new Error("workspace unavailable"); });
    await expect(f.binding.mutateAccount(0, noPause, () => {})).rejects.toThrow("workspace unavailable");
    f.binding.replace(0);
    const successor = {...f.epochs.get(0)!};
    await f.restart().retireWorkspace("workspace");
    expect(f.cleanupResolves).toEqual([reference]);
    await expect(f.restart().drainCleanup()).resolves.toBeUndefined();
    expect(f.cleanup.size).toBe(0);
    expect(f.recipients).toHaveLength(1);
    expect(f.epochs.get(0)).toEqual(successor);
  });

  it("retains an empty workspace issuance fence and accepts prior exact account acknowledgements", async () => {
    const empty = fixture();
    await empty.binding.start(0, pattern, "workspace");
    await empty.binding.retireWorkspace("workspace");
    await expect(empty.authorities[0].registerDraft(reference)).rejects.toThrow("BINDING_WORKSPACE_CLOSED");
    expect(empty.retirements.get("workspace")?.drafts).toEqual([]);
    const f = fixture();
    await f.register();
    await f.binding.mutateAccount(0, noPause, () => {});
    expect(f.cleanup.size).toBe(0);
    await f.restart().retireWorkspace("workspace");
    expect(f.cleanupResolves).toEqual([]);
    expect(f.restart().hasPendingRetirements()).toBe(false);
  });

  it.each(["ownerId", "providerAccountId", "accountIncarnation", "intendedWorkspaceId", "draftId", "grantId", "selectionDigest"])(
    "does not skip account fanout for a receipt with substituted %s", async field => {
      const f = fixture();
      await f.register();
      const row = structuredClone(f.rows.get("draft")!);
      const changed = field === "draftId" || field === "grantId" || field === "selectionDigest"
        ? {...row, reference: {...row.reference, [field]: "forged"}}
        : {...row, [field]: field === "providerAccountId" ? 99 : "forged"};
      f.receipts.set("draft", changed);
      await f.binding.mutateAccount(0, noPause, () => {});
      expect(f.recipients).toHaveLength(1);
      expect(f.recipients[0].drafts).toEqual([reference]);
      expect(f.receipts.get("draft")).toMatchObject({ownerId: row.ownerId,
        providerAccountId: row.providerAccountId, accountIncarnation: row.accountIncarnation,
        intendedWorkspaceId: row.intendedWorkspaceId, reference});
    },
  );
});

describe("actual User workspace retirement", () => {
  it("rejects retained real User draft authority after its issuance fence while cleanup is paused", async () => {
    const stub = env.TEST_USER.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (user: UserDurableObject) => {
      const accounts = user["storage"].connectedAccounts;
      type AccountRecord = NonNullable<ReturnType<typeof accounts.get>>;
      const authorities: HostDraftAuthority[] = [];
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const finalizer = new (class extends RpcTarget {
        async revoke() { entered(); await barrier; }
        [Symbol.dispose]() {}
      })();
      const account = new (class extends RpcTarget {
        async startBoundResourceConfigurator(_pattern: string, authority: HostDraftAuthority) {
          authorities.push(authority);
          return {iframeHtml: "<p>test configuration</p>"};
        }
        async resolveBoundDraftForRevocation() { return finalizer; }
      })();
      const get = vi.spyOn(accounts, "get").mockReturnValue({
        id: 0, vendorId: "openapi", account: account as unknown as AccountRecord["account"],
        description: {displayName: "API", avatar: {url: "https://workshop.test/avatar"}, hostBindingProtocol: "openapi-v1"},
      });
      try {
        await user.startBoundResourceConfigurator(0, pattern, "workspace");
        await authorities[0].registerDraft(reference);
        await user.startBoundResourceConfigurator(0, pattern, "workspace");
        expect(authorities[1]).toBeInstanceOf(RpcTarget);
        const retirement = user.retireOpenApiWorkspace("workspace");
        try {
          await Promise.race([started, retirement]);
          await expect(authorities[1].registerDraft({...reference, draftId: "late", grantId: "late-grant"}))
            .rejects.toThrow("BINDING_WORKSPACE_CLOSED");
          expect(Array.from(user["storage"].openApiDrafts.list())).toHaveLength(1);
          expect(user["storage"].openApiWorkspaceRetirements.get("workspace")?.drafts).toHaveLength(1);
          expect(user["storage"].openApiDraftCleanupReceipts.get("draft")).toBeUndefined();
          expect(get).toHaveBeenCalled();
        } finally { release(); }
        await retirement;
        expect(user["storage"].openApiDraftCleanupReceipts.get("draft")?.reference).toEqual(reference);
      } finally { release(); get.mockRestore(); }
    });
  });


  it("retries failed workspace revocation after real User eviction", async () => {
    const f = await durableCleanupFixture();
    await runInDurableObject(f.user, async instance => {
      const accounts = instance["storage"].connectedAccounts;
      const record = accounts.get(0)!;
      const finalizer = new (class extends RpcTarget {
        async revoke() { throw new Error("workspace revoker unavailable"); }
        [Symbol.dispose]() {}
      })();
      const account = new (class extends RpcTarget {
        async resolveBoundDraftForRevocation() { return finalizer; }
      })();
      const get = vi.spyOn(accounts, "get").mockReturnValue({...record,
        account: account as unknown as typeof record.account});
      try {
        await expect(instance.retireOpenApiWorkspace(f.workspace.id.toString()))
          .rejects.toThrow("workspace revoker unavailable");
        expect(get).toHaveBeenCalled();
        expect(instance["storage"].openApiWorkspaceRetirements.get(f.workspace.id.toString())?.drafts).toHaveLength(1);
        expect(instance["storage"].openApiDraftCleanupReceipts.get(reference.draftId)).toBeUndefined();
      } finally { get.mockRestore(); }
    });
    await evictDurableObject(f.user);
    expect(await runDurableObjectAlarm(f.user)).toBe(true);
    await runInDurableObject(f.user, instance => {
      expect(instance["storage"].openApiDraftCleanupReceipts.get(reference.draftId)?.reference).toEqual(reference);
      expect(instance["storage"].openApiAccountEpochs.get(0)?.live).toBe(true);
    });
    expect((await f.control.events()).cleanup).toBe(1);
  });
  it("persists retirement acknowledgement through eviction and never fans disconnect out to the retired workspace", async () => {
    const f = await durableCleanupFixture();
    await f.user.retireOpenApiWorkspace(f.workspace.id.toString());
    const before = await runInDurableObject(f.user, instance =>
      instance["storage"].openApiDraftCleanupReceipts.get(reference.draftId));
    expect(before).toMatchObject({ownerId: f.user.id.toString(), providerAccountId: 0,
      intendedWorkspaceId: f.workspace.id.toString(), reference});
    await evictDurableObject(f.user);
    await runInDurableObject(f.user, async instance => {
      expect(instance["storage"].openApiDraftCleanupReceipts.get(reference.draftId)).toEqual(before);
      const recipient = vi.spyOn(instance["ctx"].exports.OverseerDurableObject, "get")
        .mockImplementation(() => { throw new Error("retired workspace no longer exists"); });
      try {
        await instance.disconnectAccount(0);
        expect(recipient).not.toHaveBeenCalled();
        expect(instance["storage"].connectedAccounts.get(0)).toBeUndefined();
        expect(instance["storage"].openApiDraftCleanupReceipts.get(reference.draftId)).toEqual(before);
      } finally { recipient.mockRestore(); }
    });
    expect((await f.control.events()).cleanup).toBe(1);
  });
});
