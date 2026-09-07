import type { ActionRegistrationReceiptV1, EnsureActionRegistrationV1 } from "@gadgets/workshop-shared/fork/approval-registration";

const invalid = (): never => { throw new Error("InvalidApprovalPresentation"); };
const encoder = new TextEncoder();
const digestPattern = /^sha256:[0-9a-f]{64}$/;
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) invalid();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
  }
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length > maximum * 2 ||
      !value.isWellFormed() || [...value].length > maximum ||
      /[\p{Cf}\p{Cc}]/u.test(value.replace(/[\n\t]/g, ""))) invalid();
}
/** Fixed tuple, with no normalization or reinterpretation of reviewer text. */
export function encodeApprovalDescription(request: EnsureActionRegistrationV1): string {
  return JSON.stringify(["knitli-approval-description", 1, request.presentationTemplateDigest,
    request.safeDescription.title, request.safeDescription.description, false, true]);
}
function snapshot(request: EnsureActionRegistrationV1): EnsureActionRegistrationV1 {
  closed(request, ["actionId", "safeDescription", "presentationTemplateDigest", "safeDescriptionDigest"]);
  closed(request.safeDescription, ["title", "description", "implementsRevert", "awaitDecision"]);
  const { actionId, presentationTemplateDigest, safeDescriptionDigest, safeDescription } = request;
  if (!Number.isSafeInteger(actionId) || actionId < 1 ||
      typeof presentationTemplateDigest !== "string" || presentationTemplateDigest.length !== 71 || !digestPattern.test(presentationTemplateDigest) ||
      typeof safeDescriptionDigest !== "string" || safeDescriptionDigest.length !== 71 || !digestPattern.test(safeDescriptionDigest) ||
      safeDescription.implementsRevert !== false || safeDescription.awaitDecision !== true) invalid();
  text(safeDescription.title, 160);
  text(safeDescription.description, 4096);
  if (encoder.encode(safeDescription.title + safeDescription.description).byteLength > 16 * 1024) invalid();
  return { actionId, presentationTemplateDigest, safeDescriptionDigest, safeDescription: { ...safeDescription } };
}
/** Validate before hashing; the digest commits only presentation, never authority. */
export async function validateApprovalRegistration(request: EnsureActionRegistrationV1): Promise<{ canonicalBytes: string; digest: string }> {
  request = snapshot(request);
  const canonicalBytes = encodeApprovalDescription(request);
  const bytes = encoder.encode(canonicalBytes);
  if (bytes.byteLength > 16 * 1024) invalid();
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (digest !== request.safeDescriptionDigest) invalid();
  return { canonicalBytes, digest };
}
/** Permanent local key commitment, retained even if action history is pruned. */
export interface ApprovalRegistrationRecord {
  key: string;
  registrationId: number;
  canonicalBytes: string;
  digest: string;
}
/** Synchronous adapter into the host's existing action and registration collections. */
export interface ApprovalRegistrationTransaction {
  get(key: string): ApprovalRegistrationRecord | undefined;
  createPendingAction(request: EnsureActionRegistrationV1): number;
  put(record: ApprovalRegistrationRecord): void;
}
/** Identity and readiness come from a captured host queue capability. */
export interface BoundApprovalRegistrationHost {
  gatekeeperId: number;
  assertReady(): Promise<void>;
  assertActiveBindingNow(): void;
  transaction<T>(body: (tx: ApprovalRegistrationTransaction) => T): T;
  associateInsertedAction(registrationId: number): void;
  markAwaitDecisionIfPending(registrationId: number): void;
}
/** Atomically reuse or insert one host action; asynchronous work precedes the final guard. */
export async function ensureActionRegistration(host: BoundApprovalRegistrationHost,
  request: EnsureActionRegistrationV1): Promise<ActionRegistrationReceiptV1> {
  // Capture before the first await, so mutation during hashing cannot change persisted content.
  request = snapshot(request);
  const { canonicalBytes, digest } = await validateApprovalRegistration(request);
  await host.assertReady();
  let inserted = false;
  const registrationId = host.transaction(tx => {
    host.assertActiveBindingNow();
    const key = `${host.gatekeeperId}:${request.actionId}`;
    const prior = tx.get(key);
    if (prior) {
      if (prior.canonicalBytes !== canonicalBytes || prior.digest !== digest) throw new Error("ApprovalRegistrationConflict");
      return prior.registrationId;
    }
    const insertedId = tx.createPendingAction(request);
    tx.put({ key, registrationId: insertedId, canonicalBytes, digest });
    inserted = true;
    return insertedId;
  });
  if (inserted) host.associateInsertedAction(registrationId);
  host.markAwaitDecisionIfPending(registrationId);
  return { registrationId };
}
