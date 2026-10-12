import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, HookController, HookDescription, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

/**
 * One approval-queue stub shared by every capability a session hands out.
 *
 * A message or draft capability can outlive the session that produced it, so the session's
 * approval-queue stub is reference-counted rather than owned by whichever object happened to be
 * created first: every capability retains it on construction and releases it on dispose, and the
 * stub itself is disposed when the last holder goes away. Without this, each session's dup leaks
 * until the worker is evicted.
 */
export class SharedApprovalQueue {
  #stub: RpcStub<ApprovalQueue>;
  // Nothing owns the stub until the first capability is constructed; the session itself is just
  // the first of those. Starting at one would leave the count permanently above zero.
  #references = 0;

  constructor(stub: RpcStub<ApprovalQueue>) {
    this.#stub = stub;
  }

  /**
   * Hold one reference until the returned release runs. Releasing twice is safe; the stub is
   * disposed when the last outstanding reference is released.
   */
  retain(): () => void {
    this.#references++;
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      if (--this.#references === 0) this.#stub[Symbol.dispose]();
    };
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    return this.#stub.authorizeObservation(description);
  }

  submitAction(actionId: number, description: ActionDescription): Promise<void> {
    return this.#stub.submitAction(actionId, description);
  }

  bindHook<Hook extends RpcTarget>(
    controller: Fetcher<HookController<Hook>>, callback: RpcStub<Hook>, description: HookDescription,
  ): Promise<void> {
    // @ts-expect-error Workers currently widens the controller's hook type across bindHook RPC.
    return this.#stub.bindHook(controller, callback, description);
  }
}

/**
 * An RPC capability that holds one reference to the shared approval queue until disposed.
 *
 * Extend this instead of `RpcTarget` for sessions and every stub or cursor a session mints, so
 * the session's queue dup is released when the last of them is disposed rather than leaking.
 */
export class ApprovalQueueRpcTarget extends RpcTarget {
  #release: () => void;

  constructor(approvalQueue: SharedApprovalQueue) {
    super();
    this.#release = approvalQueue.retain();
  }

  [Symbol.dispose](): void {
    this.#release();
  }
}
