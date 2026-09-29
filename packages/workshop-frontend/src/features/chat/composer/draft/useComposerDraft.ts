import { useEffect, useRef, useState } from "react";
import { formatIconDataUrl } from "../../../../components/format/formatIconImage";
import { slashCommandKey } from "../../../../components/chat/slash-command-catalog";
import type { ComposerDocument } from "../composerDocument";
import {
  decorateComposerDraft,
  readComposerDraft,
  serializeComposerDraft,
  writeComposerDraft,
  type StoredComposerDraft,
} from "./composerDraft";
import {
  speechRangesAfterTextEdit,
  type SpeechRange,
  type SpeechTextSelection,
} from "./speechRanges";

export type DraftPresentationRequest = {
  id: number;
  text: string;
};

export type ComposerDocumentSnapshot = {
  document: ComposerDocument;
  documentRevision: number;
  editRevision: number;
  presentationRevision: number;
};

export type CommitDocumentEditOptions = {
  allowPresentationChanges?: boolean;
};

const speechRangesFromDraft = (draft: StoredComposerDraft | undefined): SpeechRange[] => {
  if (draft?.hasSpeech !== true) return [];
  return draft.speechRanges?.map(({ position, length }) => ({
    start: position,
    end: position + length,
  })) ?? (draft.text ? [{ start: 0, end: draft.text.length }] : []);
};

export const composerDocumentFromDraft = (
  draft: StoredComposerDraft | undefined,
): ComposerDocument => ({
  text: draft?.text ?? "",
  capsules: [],
  formats: draft?.formats.map(({ position, length, noun, icon }) => ({
    start: position,
    length,
    noun,
    icon,
  })) ?? [],
  command: draft?.command
    ? {
        start: draft.command.position,
        length: draft.command.length,
        choice: draft.command.choice,
      }
    : null,
});

const storedDraftFromDocument = (
  document: ComposerDocument,
  speechRanges: readonly SpeechRange[] = [],
): StoredComposerDraft =>
  serializeComposerDraft(
    document.text,
    document.capsules.map(({ start, length, description }) => ({
      start,
      length,
      url: description.url,
    })),
    document.formats,
    document.command ?? undefined, speechRanges.length > 0, speechRanges,
  );

const documentMatchesStoredDraft = (
  document: ComposerDocument,
  draft: StoredComposerDraft,
) => {
  const storedCommand = draft.command;
  if (document.text !== draft.text || document.capsules.length > 0 ||
      !!document.command !== !!storedCommand || document.command && storedCommand &&
      (document.command.start !== storedCommand.position ||
        document.command.length !== storedCommand.length ||
        slashCommandKey(document.command.choice.selection) !==
          slashCommandKey(storedCommand.choice.selection))) {
    return false;
  }
  return document.formats.length === draft.formats.length &&
    document.formats.every((format, index) => {
      const stored = draft.formats[index];
      return !format.logo && format.start === stored.position && format.length === stored.length &&
        format.noun === stored.noun && format.icon === stored.icon;
    });
};

const storedDraftsMatch = (
  first: StoredComposerDraft | undefined,
  second: StoredComposerDraft,
) => first !== undefined && JSON.stringify(first) === JSON.stringify(second);

const composerDocumentsMatch = (first: ComposerDocument, second: ComposerDocument) =>
  JSON.stringify(first) === JSON.stringify(second);

export const useComposerDraft = ({
  storageKey,
  logoSlot,
}: {
  storageKey: string | undefined;
  logoSlot: string;
}) => {
  const [initialDraft] = useState(() => readComposerDraft(storageKey));
  const [document, setDocument] = useState<ComposerDocument>(() =>
    composerDocumentFromDraft(initialDraft));
  const [presentationRequest, setPresentationRequest] =
    useState<DraftPresentationRequest>();
  const documentRef = useRef(document);
  const loadedKeyRef = useRef(storageKey);
  const editedRef = useRef(false);
  const editRevisionRef = useRef(0);
  const documentRevisionRef = useRef(0);
  const presentationRevisionRef = useRef(0);
  const skipWriteRef = useRef(false);
  const restoreGenerationRef = useRef(0);
  const presentationIdRef = useRef(0);
  const initialSpeechRanges = speechRangesFromDraft(initialDraft);
  const hasSpeechRef = useRef(initialSpeechRanges.length > 0);
  const speechRangesRef = useRef<SpeechRange[]>(initialSpeechRanges);
  documentRef.current = document;

  const reconcileSpeechOriginAfterTextEdit = (
    previousText: string,
    nextText: string,
    selection?: SpeechTextSelection,
  ) => {
    if (!hasSpeechRef.current || (previousText === nextText && selection === undefined)) return;
    speechRangesRef.current = speechRangesAfterTextEdit(
      speechRangesRef.current, previousText, nextText, selection,
    );
    hasSpeechRef.current = speechRangesRef.current.length > 0;
  };

  const setCurrentDocument = (
    nextDocument: ComposerDocument,
    selection?: SpeechTextSelection,
    preserveSpeechRanges = false,
  ) => {
    if (!preserveSpeechRanges) {
      reconcileSpeechOriginAfterTextEdit(documentRef.current.text, nextDocument.text, selection);
    }
    documentRef.current = nextDocument;
    documentRevisionRef.current++;
    setDocument(nextDocument);
  };

  const setPresentationDocument = (nextDocument: ComposerDocument, preserveSpeechRanges = false) => {
    presentationRevisionRef.current++;
    setCurrentDocument(nextDocument, undefined, preserveSpeechRanges);
  };

  const reconcileSpeechOriginAfterFormatDecoration = (
    draft: StoredComposerDraft,
    logos: readonly (string | undefined)[],
  ) => {
    let text = draft.text;
    let addedPrefixLength = 0;
    for (const [index, format] of draft.formats.entries()) {
      if (!logos[index]) continue;
      const position = format.position + addedPrefixLength;
      const nextText = text.slice(0, position) + logoSlot + text.slice(position);
      reconcileSpeechOriginAfterTextEdit(text, nextText, { start: position, end: position });
      text = nextText;
      addedPrefixLength += logoSlot.length;
    }
  };

  const requestPresentation = (text: string, key: string | undefined, generation: number) => {
    if (restoreGenerationRef.current !== generation || loadedKeyRef.current !== key) return;
    setPresentationRequest({ id: ++presentationIdRef.current, text });
  };

  const restorePresentation = (
    draft: StoredComposerDraft,
    key: string | undefined,
    generation: number,
  ) => {
    requestPresentation(draft.text, key, generation);
    if (draft.formats.length === 0 && !draft.command) return;

    void Promise.all(draft.formats.map(({ icon }) => formatIconDataUrl(icon))).then((logos) => {
      requestAnimationFrame(() => {
        if (restoreGenerationRef.current !== generation || loadedKeyRef.current !== key ||
            !documentMatchesStoredDraft(documentRef.current, draft)) {
          return;
        }
        const restored = decorateComposerDraft(draft, logos, logoSlot);
        reconcileSpeechOriginAfterFormatDecoration(draft, logos);
        setPresentationDocument({
          text: restored.text,
          capsules: [],
          formats: restored.formats,
          command: restored.command ?? null,
        }, true);
        requestPresentation(restored.text, key, generation);
      });
    });
  };

  useEffect(() => {
    if (!initialDraft) return;
    const generation = ++restoreGenerationRef.current;
    restorePresentation(initialDraft, storageKey, generation);
    return () => {
      if (restoreGenerationRef.current === generation) restoreGenerationRef.current++;
    };
    // This restoration belongs to the draft captured during initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loadedKeyRef.current === storageKey) return;
    const generation = ++restoreGenerationRef.current;
    const previousKey = loadedKeyRef.current;
    loadedKeyRef.current = storageKey;
    skipWriteRef.current = true;
    setPresentationRequest(undefined);
    const storedDraft = readComposerDraft(storageKey);
    const currentDocument = documentRef.current;
    const preserveLocalDraft = previousKey === undefined &&
      (editedRef.current || currentDocument.text.length > 0);
    if (preserveLocalDraft) {
      writeComposerDraft(storageKey, storedDraftFromDocument(currentDocument, speechRangesRef.current));
      skipWriteRef.current = false;
      return;
    }

    if (previousKey !== undefined) editedRef.current = false;
    const restoredSpeechRanges = speechRangesFromDraft(storedDraft);
    hasSpeechRef.current = restoredSpeechRanges.length > 0;
    const nextDocument = {
      ...composerDocumentFromDraft(storedDraft),
      capsules: previousKey === undefined ? currentDocument.capsules : [],
    };
    speechRangesRef.current = restoredSpeechRanges;
    if (previousKey !== undefined || !composerDocumentsMatch(currentDocument, nextDocument)) {
      setCurrentDocument(nextDocument, undefined, true);
    }
    if (storedDraft) restorePresentation(storedDraft, storageKey, generation);
    return () => {
      if (restoreGenerationRef.current === generation) restoreGenerationRef.current++;
    };
  }, [storageKey]);

  useEffect(() => {
    if (skipWriteRef.current) {
      skipWriteRef.current = false;
      return;
    }
    writeComposerDraft(storageKey, storedDraftFromDocument(document, speechRangesRef.current));
  }, [document, storageKey]);

  const recordEdit = () => {
    editedRef.current = true;
    editRevisionRef.current++;
    restoreGenerationRef.current++;
    setPresentationRequest(undefined);
  };

  const beginSend = (): { key: string | undefined; editRevision: number; draft: StoredComposerDraft; hasSpeech?: boolean } => ({
    key: loadedKeyRef.current,
    editRevision: editRevisionRef.current,
    draft: storedDraftFromDocument(documentRef.current, speechRangesRef.current),
    ...(hasSpeechRef.current && { hasSpeech: true }),
  });

  const completeSend = (send: ReturnType<typeof beginSend>): boolean => {
    if (loadedKeyRef.current !== send.key) {
      if (storedDraftsMatch(readComposerDraft(send.key), send.draft)) {
        writeComposerDraft(send.key, undefined);
      }
      return false;
    }
    if (editRevisionRef.current !== send.editRevision) return false;
    writeComposerDraft(send.key, undefined);
    hasSpeechRef.current = false;
    speechRangesRef.current = [];
    editedRef.current = false;
    return true;
  };

  const updateDocument = (update: (current: ComposerDocument) => ComposerDocument) => {
    setCurrentDocument(update(documentRef.current));
  };

  const replaceDocument = (nextDocument: ComposerDocument, selection?: SpeechTextSelection) => {
    setCurrentDocument(nextDocument, selection);
  };

  const markSpeechOrigin = (text = documentRef.current.text) => {
    if (!text) return;
    const end = documentRef.current.text.length;
    speechRangesRef.current.push({ start: end - text.length, end });
    hasSpeechRef.current = true;
  };
  const clearSpeechOriginWhenEmpty = (text: string) => {
    if (text === "") {
      hasSpeechRef.current = false;
      speechRangesRef.current = [];
    }
  };

  const getDocumentSnapshot = (): ComposerDocumentSnapshot => ({
    document: documentRef.current,
    documentRevision: documentRevisionRef.current,
    editRevision: editRevisionRef.current,
    presentationRevision: presentationRevisionRef.current,
  });

  const commitDocumentEdit = <T extends { document: ComposerDocument; textEdit?: SpeechTextSelection }>(
    snapshot: ComposerDocumentSnapshot,
    transition: (current: ComposerDocument) => T | null,
    options?: CommitDocumentEditOptions,
  ): (T & { documentRevision: number; editRevision: number }) | null => {
    if (documentRevisionRef.current !== snapshot.documentRevision) {
      const documentChanges = documentRevisionRef.current - snapshot.documentRevision;
      const presentationChanges =
        presentationRevisionRef.current - snapshot.presentationRevision;
      if (!options?.allowPresentationChanges || documentChanges !== presentationChanges) {
        return null;
      }
    }
    const result = transition(documentRef.current);
    if (!result) return null;
    recordEdit();
    setCurrentDocument(result.document, result.textEdit);
    return {
      ...result,
      documentRevision: documentRevisionRef.current,
      editRevision: editRevisionRef.current,
    };
  };

  return {
    beginSend,
    commitDocumentEdit,
    completeSend,
    document,
    getDocumentSnapshot,
    presentationRequest,
    recordEdit,
    replaceDocument,
    updateDocument,
    markSpeechOrigin,
    clearSpeechOriginWhenEmpty,
  };
};
