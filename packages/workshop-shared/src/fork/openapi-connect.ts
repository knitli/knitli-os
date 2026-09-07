import type { WorkerEntrypoint } from "cloudflare:workers";
import type { GatekeeperUser, GatekeeperConnectOptions } from "../gatekeeper";

/** Identity supplied exclusively by the authenticated host's retained capability. */
export type OpenApiConnectIdentity = {
  /** Opaque authenticated User DO identifier. */
  ownerId: string;
  /** Configured vendor that received this capability. */
  vendorId: string;
  /** Opaque, independently admitted connection attempt. */
  connectAttemptId: string;
  /** Host initiation deadline; an already committed exact completion remains retryable afterward. */
  expiresAt: number;
  /** Host connection generation being replaced, distinct from the Account credential counter. */
  expectedConnectionGeneration?: number;
};

/** Exact orphan credential receipt named by a fresh authenticated first-connect attempt. */
export type OpenApiFirstConnectReservation = {
  /** Admitted provider profile. */
  profileId: string;
  /** Provider-verified principal in the authenticated owner namespace. */
  principalId: string;
  /** Exact prior connector receipt; the destination independently verifies its credential generation. */
  previousReceiptDigest: string;
  /** Immutable destination that may publish the successor credential receipt. */
  destinationCommitment: string;
};
/** Host canonical-key reservation, bounded by the fresh attempt's existing lifetime. */
export type OpenApiFirstConnectReservationReceipt = OpenApiFirstConnectReservation & {
  /** Fresh host authority that exclusively owns this reservation. */
  connectAttemptId: string;
  /** Original host attempt deadline; retries never extend it. */
  expiresAt: number;
};
/** Immutable credential completion; contains no credentials or browser-provided owner identity. */
export type OpenApiConnectCompletion = {
  /** Admitted provider profile. */
  profileId: string;
  /** Provider-verified principal. */
  principalId: string;
  /** Original Account capability, retained on first completion only. */
  account: Fetcher<GatekeeperUser>;
  /** SHA-256 digest of the immutable connector credential receipt. */
  receiptDigest: string;
  /** Immutable connector destination commitment; display names are not identity. */
  destinationCommitment: string;
};

/** Durable canonical connection acknowledgement. */
export type OpenApiConnectReceipt = {
  /** Existing host connected-account row ID. */
  providerAccountId: number;
  /** Existing host account lifecycle incarnation. */
  accountIncarnation: string;
  /** Host connection generation; credential refresh does not advance this counter. */
  connectionGeneration: number;
  /** Notifications fenced to this exact completion. */
  notifications: Fetcher<OpenApiConnectionNotifications>;
};

/** Persistable private port minted only by an authenticated User. Never exposed to browser code. */
export interface OpenApiConnectAuthority extends WorkerEntrypoint {
  /** Check admission and obtain host-owned identity before reading provider profiles. */
  getIdentity(): Promise<OpenApiConnectIdentity>;
  /** Recheck attempt admission immediately before external effects. */
  assertActive(): Promise<void>;
  /** Reserve a never-completed canonical key; historical disconnected connections also reject. */
  reserveFirstConnect(request: OpenApiFirstConnectReservation): Promise<OpenApiFirstConnectReservationReceipt>;
  /** Commit once; exact retries retain the original Account and never invoke a supplied replacement. */
  complete(request: OpenApiConnectCompletion): Promise<OpenApiConnectReceipt>;
  /** Admit a reconnect only while this receipt and numeric generation remain current. */
  beginReconnect(expectedConnectionGeneration: number): Promise<Fetcher<OpenApiConnectAuthority>>;
}

/** Persistable notifications carry no completion or account replacement authority. */
export interface OpenApiConnectionNotifications extends WorkerEntrypoint {
  /** Mark credentials expired only if the bound canonical receipt is current. */
  credentialsExpired(): Promise<void>;
  /** Restore only that same receipt; revalidate after fetching the Account description. */
  credentialsRestored(expiresAt?: Date): Promise<void>;
}

/** Private extension selected by VendorDescription.hostConnectProtocol. */
export interface OpenApiConnectVendor extends WorkerEntrypoint {
  /** Start authenticated OpenAPI enrollment without a generic account-replacement callback. */
  connectBoundAccount(authority: Fetcher<OpenApiConnectAuthority>, options?: GatekeeperConnectOptions): Promise<{ url: string }>;
}
