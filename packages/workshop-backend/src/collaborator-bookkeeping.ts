/**
 * Runs detached collaborator bookkeeping with authorization rechecked at every remote-call
 * boundary. `isAuthorized` must be synchronous so no listing write or output sync follows an
 * asynchronous gap without a fresh decision.
 */
export async function runAuthorizedCollaboratorBookkeeping<OwnerProfile>({
  resolveOwnerProfile,
  recordSharedGadgetOpen,
  reconcileRevokedListing,
  syncOutputs,
  isAuthorized,
  reportError,
}: {
  resolveOwnerProfile: () => Promise<OwnerProfile>;
  recordSharedGadgetOpen: (ownerProfile: OwnerProfile) => Promise<void>;
  reconcileRevokedListing: () => Promise<void>;
  syncOutputs: () => Promise<void>;
  isAuthorized: () => boolean;
  reportError: (operation: "record" | "reconcile" | "sync", error: unknown) => void;
}): Promise<void> {
  let reconcile = async (): Promise<void> => {
    try {
      await reconcileRevokedListing();
    } catch (error) {
      reportError("reconcile", error);
    }
  };

  let ownerProfile: OwnerProfile;
  try {
    ownerProfile = await resolveOwnerProfile();
  } catch (error) {
    reportError("record", error);
    return;
  }
  if (!isAuthorized()) {
    await reconcile();
    return;
  }

  try {
    await recordSharedGadgetOpen(ownerProfile);
  } catch (error) {
    reportError("record", error);
    if (!isAuthorized()) await reconcile();
    return;
  }

  // recordSharedGadgetOpen() is a remote write with ambiguous completion on failure. If authority
  // changed while it ran, explicitly reconcile the possibly-created listing before returning.
  if (!isAuthorized()) {
    await reconcile();
    return;
  }

  try {
    await syncOutputs();
  } catch (error) {
    reportError("sync", error);
  }
}
