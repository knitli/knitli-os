import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  BoundIdentity,
  HostDispatchUseAuthority,
  HostFacetBinding,
} from "@gadgets/workshop-shared/fork/openapi-host-binding";
import { BindingError, type BindingRow, type HostBindingLedger } from "./openapi-binding-ledger";

/** Dispatch uses the facet's authoritative store and its local and remote fences. */
export interface OpenApiDispatchBindingContext {
  ledger: HostBindingLedger;
  assertActiveNow(identity: BoundIdentity): BindingRow;
  assertAccountReady(identity: BoundIdentity): Promise<void>;
}

/** Private lifecycle adapter; only its attenuated per-registration capability leaves the host. */
export function createOpenApiDispatchBinding(context: OpenApiDispatchBindingContext) {
  return {
    async authorizeDispatchKey(
      identity: BoundIdentity,
      request: Parameters<HostFacetBinding["authorizeDispatchKey"]>[0],
    ): ReturnType<HostFacetBinding["authorizeDispatchKey"]> {
      const captured = structuredClone(identity);
      const { keyId, publicKeyDigest } = request;
      context.assertActiveNow(captured);
      await context.assertAccountReady(captured);
      context.assertActiveNow(captured);
      const keyEpoch = context.ledger.authorizeKey(captured, keyId, publicKeyDigest);
      const use = new (class extends RpcTarget implements HostDispatchUseAuthority {
        async assertActive(): Promise<void> {
          context.assertActiveNow(captured);
          await context.assertAccountReady(captured);
          const row = context.assertActiveNow(captured);
          context.ledger.assertActive(captured, keyEpoch);
          if (row.key?.keyId !== keyId || row.key.publicKeyDigest !== publicKeyDigest) {
            throw new BindingError("DISPATCH_KEY_CONFLICT");
          }
          // Liveness is not network-hop authorization: the connector must also hold its
          // dispatch lease and recheck profile/action fences after preparation/credential awaits.
        }
      })();
      return { identity: structuredClone(captured), keyEpoch, use: new RpcStub(use) };
    },
    async revokeDispatchKey(
      identity: BoundIdentity,
      registration: Parameters<HostFacetBinding["revokeDispatchKey"]>[0],
    ): Promise<void> {
      // Cleanup must acknowledge an already fenced exact identity without account readiness.
      // The ledger validates the tuple and makes a delayed retired-epoch revoke successor-safe.
      context.ledger.revokeKey(identity, registration);
    },
  };
}
