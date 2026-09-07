/** Exact, bounded reviewer presentation; every v1 write requires manual approval. */
export interface SafeActionDescriptionV1 {
  title: string;
  description: string;
  implementsRevert: false;
  awaitDecision: true;
}
/** One connector-local action and its immutable presentation commitment. */
export interface EnsureActionRegistrationV1 {
  actionId: number;
  safeDescription: SafeActionDescriptionV1;
  presentationTemplateDigest: string;
  safeDescriptionDigest: string;
}
/** Existing host action row identifier, including on exact retry. */
export interface ActionRegistrationReceiptV1 { registrationId: number }
