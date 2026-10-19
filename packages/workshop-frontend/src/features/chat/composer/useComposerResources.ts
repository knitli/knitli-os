import { useEffect, useRef, useState } from "react";
import type { RpcStub } from "capnweb";
import type { GatekeeperClient, Overseer } from "@gadgets/workshop-shared/api";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  ConnectionRestartError,
  consumeCreatedConnection,
  discardCreatedConnection,
} from "../../../connectionRestartRecovery";
import { normalizeResourceUrl } from "../../../resourceMatching";
import { rpcFailureDescription } from "../../../rpcErrors";
import {
  insertComposerCapsule,
  refineComposerResourceUrl,
  replaceComposerUrlWithCapsule,
  type ComposerCapsule,
  type ComposerDocument,
  type ComposerSelection,
  type ComposerUrlRange,
} from "./composerDocument";
import type {
  CommitDocumentEditOptions,
  ComposerDocumentSnapshot,
} from "./draft/useComposerDraft";

const URL_REGEX = /https?:\/\/[^\s)>\]]*/g;

type CommittedTransition<T extends { document: ComposerDocument }> =
  (T & { documentRevision: number; editRevision: number }) | null;

type ActiveResourceUrl = ComposerUrlRange & {
  snapshot: ComposerDocumentSnapshot;
};

/** The connection the URL picker chose for a URL: an account, and the resource of its vendor. */
export type ComposerResourceResolution = {
  accountId: number;
  vendorId: string;
  /** The `SupportedResource.urlPattern` the URL was matched to. */
  resourceUrlPattern: string;
};

/** A URL the attach modal was opened to configure, and the connection the picker chose for it. */
export type ComposerAttachModalPrefill = {
  url: string;
  resolution: ComposerResourceResolution;
};

// Where a capsule the attach modal creates goes: at a caret position, or in place of a URL.
type AttachTarget =
  | { type: "position"; snapshot: ComposerDocumentSnapshot; position: number }
  | { type: "url"; source: ActiveResourceUrl };

const PROMPT_CHANGED_MESSAGE = "The prompt changed before the resource could be added";

type UseComposerResourcesOptions = {
  createCapsuleGatekeeper: (
    accountId: number,
    url: string,
  ) => Promise<RpcStub<GatekeeperClient<any>> | null>;
  // Fork: read on every recovery attempt, since a connection's creation can restart the
  // workspace and only the reopened overseer reaches it then (see consumeCreatedConnection).
  // Without it, a restart-class failure is not recovered.
  getOverseer?: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  getDocumentSnapshot: () => ComposerDocumentSnapshot;
  commitDocumentEdit: <T extends { document: ComposerDocument }>(
    snapshot: ComposerDocumentSnapshot,
    transition: (current: ComposerDocument) => T | null,
    options?: CommitDocumentEditOptions,
  ) => CommittedTransition<T>;
  capsuleTokenText: (description: ResourceDescription, vendorId?: string) => string;
  onConnectionCreated: () => void;
  onSelectionRequest: (selection: ComposerSelection, documentRevision: number) => void;
  /**
   * Reports a failure. `configure` is offered when a URL could not be connected directly: it opens
   * the attach modal on that URL, whose capsule then replaces it.
   */
  onError: (title: string, description?: string, configure?: () => void) => void;
};

const currentResourceUrl = (
  source: ActiveResourceUrl,
  document: ComposerDocument,
): ComposerUrlRange | null => {
  const originalUrls = [
    ...source.snapshot.document.text.matchAll(/https?:\/\/[^\s)>\]]*/g),
  ];
  const sourceIndex = originalUrls.findIndex((match) =>
    match.index === source.start && match.index + match[0].length === source.end &&
    match[0] === source.text);
  if (sourceIndex < 0) return null;

  const match = [...document.text.matchAll(/https?:\/\/[^\s)>\]]*/g)][sourceIndex];
  if (!match || match[0] !== source.text) return null;
  return { text: match[0], start: match.index, end: match.index + match[0].length };
};

// The first occurrence of `url` outside a capsule, wherever edits have moved it.
const findResourceUrl = (url: string, document: ComposerDocument): ComposerUrlRange | null => {
  for (const match of document.text.matchAll(/https?:\/\/[^\s)>\]]*/g)) {
    const start = match.index;
    const end = start + match[0].length;
    const isCapsule = document.capsules.some((capsule) =>
      start >= capsule.start && end <= capsule.start + capsule.length);
    if (match[0] === url && !isCapsule) return { text: url, start, end };
  }
  return null;
};

const currentPresentationPosition = (
  source: ComposerDocumentSnapshot,
  document: ComposerDocument,
  position: number,
): number | null => {
  if (source.document.formats.length !== document.formats.length) return null;
  let shift = 0;
  for (const [index, previous] of source.document.formats.entries()) {
    const current = document.formats[index];
    if (current.noun !== previous.noun || current.icon !== previous.icon ||
        current.start !== previous.start + shift) {
      return null;
    }
    if (position > previous.start && position < previous.start + previous.length) return null;
    if (position >= previous.start + previous.length) {
      shift += current.length - previous.length;
    }
  }
  return position + shift;
};

export const useComposerResources = ({
  createCapsuleGatekeeper,
  getOverseer,
  getDocumentSnapshot,
  commitDocumentEdit,
  capsuleTokenText,
  onConnectionCreated,
  onSelectionRequest,
  onError,
}: UseComposerResourcesOptions) => {
  const [activeUrl, setActiveUrl] = useState<ActiveResourceUrl | null>(null);
  const [attachModal, setAttachModal] = useState<{
    prefill?: ComposerAttachModalPrefill;
  } | null>(null);
  const [isCreatingResource, setIsCreatingResource] = useState(false);
  const activeUrlRef = useRef(activeUrl);
  const attachTargetRef = useRef<AttachTarget | undefined>(undefined);
  const operationRef = useRef(0);
  const lastScanRef = useRef({ position: -1, text: "", documentRevision: -1 });
  const getOverseerRef = useRef(getOverseer);
  activeUrlRef.current = activeUrl;
  getOverseerRef.current = getOverseer;
  const getCurrentOverseer = () =>
    getOverseerRef.current?.() ?? Promise.reject(new Error("No overseer to recover through"));

  useEffect(() => () => {
    operationRef.current++;
    attachTargetRef.current = undefined;
  }, []);

  const hideUrl = () => {
    activeUrlRef.current = null;
    setActiveUrl(null);
  };

  const dismissUrl = () => {
    operationRef.current++;
    setIsCreatingResource(false);
    hideUrl();
  };

  const scanAt = (position: number) => {
    const snapshot = getDocumentSnapshot();
    const { document, documentRevision } = snapshot;
    const scanned = lastScanRef.current;
    if (scanned.position === position && scanned.text === document.text &&
        scanned.documentRevision === documentRevision) {
      return;
    }
    lastScanRef.current = { position, text: document.text, documentRevision };

    URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_REGEX.exec(document.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (position < start || position > end) continue;
      const isCapsule = document.capsules.some((capsule) =>
        start >= capsule.start && end <= capsule.start + capsule.length);
      if (isCapsule) break;

      const previous = activeUrlRef.current;
      if (previous?.text === match[0] && previous.start === start && previous.end === end &&
          previous.snapshot.documentRevision === documentRevision) {
        return;
      }
      const next = { text: match[0], start, end, snapshot };
      activeUrlRef.current = next;
      setActiveUrl(next);
      return;
    }
    hideUrl();
  };

  const replaceUrlWithCapsule = (
    source: ActiveResourceUrl,
    capsule: Omit<ComposerCapsule, "start" | "length">,
  ) => commitDocumentEdit(source.snapshot, (document) => {
    const url = currentResourceUrl(source, document);
    return url && replaceComposerUrlWithCapsule(
      document,
      url,
      capsule,
      capsuleTokenText(capsule.description, capsule.vendorId),
    );
  }, { allowPresentationChanges: true });

  const openUrlInAttachModal = (source: ActiveResourceUrl, prefill: ComposerAttachModalPrefill) => {
    if (attachTargetRef.current) return;
    // A snapshot taken now, so edits made before the modal opened don't reject its capsule. The
    // occurrence the picker was opened on while it can still be tracked, else the first copy.
    const snapshot = getDocumentSnapshot();
    const url = currentResourceUrl(source, snapshot.document) ??
      findResourceUrl(source.text, snapshot.document);
    if (!url) {
      onError(PROMPT_CHANGED_MESSAGE);
      return;
    }
    attachTargetRef.current = { type: "url", source: { ...url, snapshot } };
    hideUrl();
    setAttachModal({ prefill });
  };

  const createCapsule = async (resolution: ComposerResourceResolution) => {
    const source = activeUrlRef.current;
    if (!source) return;
    const operation = ++operationRef.current;
    const url = normalizeResourceUrl(source.text);
    const configure = () => openUrlInAttachModal(source, { url, resolution });
    setIsCreatingResource(true);
    try {
      const gatekeeper = await createCapsuleGatekeeper(resolution.accountId, url);
      if (!gatekeeper) {
        if (operationRef.current !== operation) return;
        onError("Failed to create resource connection", undefined, configure);
        return;
      }
      await consumeCreatedConnection(gatekeeper, (connection) => connection.describe(),
          getCurrentOverseer, (gatekeeperId, description) => {
        if (operationRef.current !== operation) return false;
        const result = replaceUrlWithCapsule(
          source,
          { gatekeeperId, description, vendorId: resolution.vendorId },
        );
        if (!result) {
          onError(PROMPT_CHANGED_MESSAGE);
          dismissUrl();
          return false;
        }
        dismissUrl();
        onSelectionRequest({ start: result.caret, end: result.caret }, result.documentRevision);
        onConnectionCreated();
        return true;
      });
    } catch (error) {
      if (operationRef.current !== operation) return;
      console.error("Failed to create capsule:", error);
      if (error instanceof ConnectionRestartError) onError(error.message);
      else onError("Failed to add resource", rpcFailureDescription(error), configure);
    } finally {
      if (operationRef.current === operation) setIsCreatingResource(false);
    }
  };

  const refineUrl = (newUrl: string, placeholderStart: number, placeholderEnd: number) => {
    const source = activeUrlRef.current;
    if (!source) return;
    const result = commitDocumentEdit(source.snapshot, (document) =>
      refineComposerResourceUrl(
        document,
        source,
        newUrl,
        { start: placeholderStart, end: placeholderEnd },
      ));
    if (!result) {
      dismissUrl();
      return;
    }
    const next = {
      ...result.activeUrl,
      snapshot: getDocumentSnapshot(),
    };
    activeUrlRef.current = next;
    setActiveUrl(next);
    onSelectionRequest(result.selection, result.documentRevision);
  };

  const openAttachModal = (position: number) => {
    const snapshot = getDocumentSnapshot();
    if (position < 0 || position > snapshot.document.text.length) {
      return;
    }
    attachTargetRef.current = { type: "position", snapshot, position };
    setAttachModal({});
  };

  const closeAttachModal = () => {
    attachTargetRef.current = undefined;
    setAttachModal(null);
  };

  const attachCreated = async (gatekeeper: RpcStub<GatekeeperClient<any>>) => {
    const target = attachTargetRef.current;
    if (!target) return discardCreatedConnection(gatekeeper);
    try {
      await consumeCreatedConnection(gatekeeper,
          (connection) => Promise.all([connection.describe(), connection.getCreationSpec()]),
          getCurrentOverseer, (gatekeeperId, [description, creationSpec]) => {
      if (attachTargetRef.current !== target) return false;
      const vendorId = creationSpec.type === "gatekeeper" ? creationSpec.vendorId : undefined;
      const capsule = { gatekeeperId, description, vendorId };
      const result = target.type === "url"
        ? replaceUrlWithCapsule(target.source, capsule)
        : commitDocumentEdit(target.snapshot, (document) => {
          const position = currentPresentationPosition(target.snapshot, document, target.position);
          return position === null ? null : insertComposerCapsule(
            document,
            position,
            capsule,
            capsuleTokenText(description, vendorId),
          );
        }, { allowPresentationChanges: true });
      closeAttachModal();
      if (!result) {
        onError(PROMPT_CHANGED_MESSAGE);
        return false;
      }
      onSelectionRequest({ start: result.caret, end: result.caret }, result.documentRevision);
      onConnectionCreated();
      return true;
      });
    } catch (error) {
      if (attachTargetRef.current !== target) return;
      throw error;
    }
  };

  return {
    activeUrl,
    attachCreated,
    attachModalOpen: attachModal !== null,
    attachModalPrefill: attachModal?.prefill,
    closeAttachModal,
    createCapsule,
    dismissUrl,
    isCreatingResource,
    openAttachModal,
    refineUrl,
    scanAt,
  };
};
