import { describe, expect, it, vi } from "vitest";
import type { RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { ApprovalQueueRpcTarget, SharedApprovalQueue } from "../../src/shared-approval-queue";

function fakeQueue() {
  return {
    authorizeObservation: vi.fn(async () => {}),
    submitAction: vi.fn(async () => {}),
    [Symbol.dispose]: vi.fn(),
  };
}

describe("SharedApprovalQueue", () => {
  it("disposes the stub when the last reference is released", () => {
    const stub = fakeQueue();
    const shared = new SharedApprovalQueue(stub as unknown as RpcStub<ApprovalQueue>);
    const releaseFirst = shared.retain();
    const releaseSecond = shared.retain();

    releaseFirst();
    expect(stub[Symbol.dispose]).not.toHaveBeenCalled();
    releaseSecond();
    expect(stub[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("ignores a repeated release instead of disposing early", () => {
    const stub = fakeQueue();
    const shared = new SharedApprovalQueue(stub as unknown as RpcStub<ApprovalQueue>);
    const releaseFirst = shared.retain();
    const releaseSecond = shared.retain();

    releaseFirst();
    releaseFirst();
    expect(stub[Symbol.dispose]).not.toHaveBeenCalled();
    releaseSecond();
    expect(stub[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("forwards queue calls to the stub", async () => {
    const stub = fakeQueue();
    const shared = new SharedApprovalQueue(stub as unknown as RpcStub<ApprovalQueue>);
    const description = { title: "t" } as never;

    await shared.authorizeObservation(description);
    await shared.submitAction(7, description);
    expect(stub.authorizeObservation).toHaveBeenCalledOnce();
    expect(stub.submitAction).toHaveBeenCalledWith(7, description);
  });
});

describe("ApprovalQueueRpcTarget", () => {
  it("holds one reference until disposed", () => {
    const stub = fakeQueue();
    const shared = new SharedApprovalQueue(stub as unknown as RpcStub<ApprovalQueue>);

    using first = new ApprovalQueueRpcTarget(shared);
    {
      using _second = new ApprovalQueueRpcTarget(shared);
    }
    expect(stub[Symbol.dispose]).not.toHaveBeenCalled();
    void first;
  });

  it("disposes the stub once the last derived target is disposed", () => {
    const stub = fakeQueue();
    const shared = new SharedApprovalQueue(stub as unknown as RpcStub<ApprovalQueue>);

    {
      using _session = new ApprovalQueueRpcTarget(shared);
      using _cursor = new ApprovalQueueRpcTarget(shared);
    }
    expect(stub[Symbol.dispose]).toHaveBeenCalledOnce();
  });
});
