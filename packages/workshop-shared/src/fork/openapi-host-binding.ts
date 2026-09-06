import type { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { Gatekeeper, ResourceConfiguratorFrame, SupportedResource } from "../gatekeeper";

/** Immutable public locator for a registered connector draft. */
export type DraftReference = {
  /** Unique draft identifier; never reused. */
  draftId: string;
  /** Immutable connector grant identifier. */
  grantId: string;
  /** Digest of the immutable selected configuration. */
  selectionDigest: string;
};
/** Complete host-owned identity of one reserved facet generation. */
export type BoundIdentity = DraftReference & {
  /** Authenticated User DO identifier. */
  ownerId: string;
  /** Connected account row identifier. */
  providerAccountId: number;
  /** Immutable incarnation fenced on disconnect or replacement. */
  accountIncarnation: string;
  /** Authoritative Overseer DO identifier. */
  workspaceId: string;
  /** Monotonically allocated workpiece identifier. */
  gatekeeperId: number;
  /** Actual host facet name, gatekeeper followed by its workpiece identifier. */
  facetName: string;
  /** Immutable positive binding generation. */
  generation: number;
};
/** Private account configurator authority scoped to an owner, account and workspace. */
export interface HostDraftAuthority extends RpcTarget {
  /** Register an immutable reference and return its original expiry on exact retry. */
  registerDraft(reference: DraftReference): Promise<{
    /** Original absolute draft expiry in milliseconds. */
    expiresAt: number;
  }>;
  /** Permanently cancel a draft owned by this configurator authority. */
  cancelDraft(draftId: string): Promise<void>;
}
/** Attenuated liveness authority for one exact dispatch registration. */
export interface HostDispatchUseAuthority extends RpcTarget {
  /** Reject unless this exact dispatch registration remains live. */
  assertActive(): Promise<void>;
}
/** Private lifecycle authority retained by the trusted grant coordinator. */
export interface HostFacetBinding extends RpcTarget {
  /** Return the immutable reserved identity without secrets. */
  getIdentity(): Promise<BoundIdentity>;
  /** Confirm the trusted connector accepted the exact selection and identity. */
  confirmActivation(selectionDigest: string): Promise<void>;
  /** Authorize one active key registration and return its attenuated use capability. */
  authorizeDispatchKey(request: {
    /** Public registration identifier within this private binding. */
    keyId: string;
    /** Digest of the registered public key. */
    publicKeyDigest: string;
  }): Promise<{
    /** Immutable host-reserved identity. */
    identity: BoundIdentity;
    /** Monotonic epoch of this exact key registration. */
    keyEpoch: number;
    /** Attenuated capability that checks only this registration. */
    use: RpcStub<HostDispatchUseAuthority>;
  }>;
  /** Revoke only the exact key registration, preserving successor epochs. */
  revokeDispatchKey(registration: {
    /** Public registration identifier within this private binding. */
    keyId: string;
    /** Digest of the registered public key. */
    publicKeyDigest: string;
    /** Exact monotonic registration epoch to revoke. */
    keyEpoch: number;
  }): Promise<void>;
}
/** Private exact-draft cleanup authority; cannot activate or dispatch. */
export interface OpenApiRevocationFinalizer extends RpcTarget {
  /** Fence new dispatches and acknowledge only after admitted dispatches drain. */
  revoke(reason: "removed" | "account-disconnected" | "creation-failed"): Promise<void>;
}
/** Private draft-scoped connector activation and revocation capability. */
export interface OpenApiFacetFinalizer extends OpenApiRevocationFinalizer {
  /** Exact active grant has lost its transient host capabilities; errors never request replay. */
  needsActivationReplay?(): Promise<boolean>;
  /** Install the private host capability into this exact draft grant. */
  activate(binding: RpcStub<HostFacetBinding>): Promise<void>;
}
/** Explicit v1 extension used only over authenticated host service RPC. */
export interface OpenApiBoundAccount extends WorkerEntrypoint {
  /** Start configuration with host-derived owner, account and workspace authority. */
  startBoundResourceConfigurator(
    pattern: string,
    authority: RpcStub<HostDraftAuthority>,
  ): Promise<ResourceConfiguratorFrame>;
  /** Resolve only exact immutable draft cleanup, including after account revocation or restart. */
  resolveBoundDraftForRevocation(reference: DraftReference): Promise<RpcStub<OpenApiRevocationFinalizer>>;
  /** Resolve the exact draft into its class, resource and private finalizer. */
  resolveBoundDraft(reference: DraftReference): Promise<{
    /** Class resolved by the authenticated account for this draft. */
    class: DurableObjectClass<Gatekeeper<any>>;
    /** Resource description subject to existing host policy. */
    resource: SupportedResource;
    /** Canonical URL derived from the immutable stored draft, never caller input. */
    resourceUrl: string;
    /** Explicit support for probing lost transient activation capabilities. */
    supportsActivationReplay?: boolean;
    /** Private draft-scoped capability retained only by the host. */
    finalizer: RpcStub<OpenApiFacetFinalizer>;
  }>;
}
