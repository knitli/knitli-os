import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user";
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
  type OpenApiUserBindingContext,
} from "../src/fork/openapi-user-binding";
import type { BindingRow } from "../src/fork/openapi-binding-ledger";
declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
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
  let policyPause = noPause;
  const ui = new (class extends RpcTarget {})();
  const finalizer = new (class extends RpcTarget {
    async activate() {
      calls.activate++;
    }
    async revoke() {}
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
        let revokeCalls = 0;
        const oldAccount = new (class extends RpcTarget {
          async describe() {
            return description;
          }
          async revoke() {
            revokeCalls++;
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
