// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertComposerFormat, type ComposerDocument } from "../composerDocument";
import type { StoredComposerDraft } from "./composerDraft";

const iconState = vi.hoisted(() => ({
  resolve: undefined as ((url: string) => void) | undefined,
  resolves: [] as Array<(url: string) => void>,
}));

vi.mock("../../../../components/format/formatIconImage", () => ({
  formatIconDataUrl: () => new Promise<string>((resolve) => {
    iconState.resolve = resolve;
    iconState.resolves.push(resolve);
  }),
}));

import { readComposerDraft, writeComposerDraft } from "./composerDraft";
import {
  type CommitDocumentEditOptions,
  type ComposerDocumentSnapshot,
  useComposerDraft,
} from "./useComposerDraft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DraftControls = {
  beginSend: () => {
    key: string | undefined;
    editRevision: number;
    draft: StoredComposerDraft;
    hasSpeech?: boolean;
  };
  completeSend: (send: {
    key: string | undefined;
    editRevision: number;
    draft: StoredComposerDraft;
  }) => boolean;
  commitDocumentEdit: (
    snapshot: ComposerDocumentSnapshot,
    transition: (document: ComposerDocument) => { document: ComposerDocument } | null,
    options?: CommitDocumentEditOptions,
  ) => ({
    document: ComposerDocument;
    documentRevision: number;
    editRevision: number;
  }) | null;
  document: ComposerDocument;
  getDocumentSnapshot: () => ComposerDocumentSnapshot;
  recordEdit: () => void;
  markSpeechOrigin: (text?: string) => void;
  clearSpeechOriginWhenEmpty: (text: string) => void;
  replaceDocument: (document: ComposerDocument, selection?: { start: number; end: number }) => void;
};

const emptyDocument = (text = ""): ComposerDocument => ({
  text,
  capsules: [],
  formats: [],
  command: null,
});

describe("useComposerDraft", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;
  let controls: DraftControls;

  const Harness = ({ storageKey }: { storageKey?: string }) => {
    const draft = useComposerDraft({
      storageKey,
      logoSlot: "\u2003\u2060\u00a0",
    });
    controls = {
      beginSend: draft.beginSend,
      commitDocumentEdit: draft.commitDocumentEdit,
      completeSend: draft.completeSend,
      document: draft.document,
      getDocumentSnapshot: draft.getDocumentSnapshot,
      recordEdit: draft.recordEdit,
      markSpeechOrigin: draft.markSpeechOrigin,
      clearSpeechOriginWhenEmpty: draft.clearSpeechOriginWhenEmpty,
      replaceDocument: draft.replaceDocument,
    };
    return null;
  };

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
    iconState.resolve = undefined;
    iconState.resolves = [];
    vi.unstubAllGlobals();
  });

  it("adopts a late storage key without replacing a local edit", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));

    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("local prompt"));
    });
    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));

    expect(controls.document.text).toBe("local prompt");
    expect(readComposerDraft("draft:user-a")?.text).toBe("local prompt");
  });

  it("persists, clears, and sends speech provenance with the draft lifecycle", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:voice" />));
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("dictated words"));
      controls.markSpeechOrigin();
    });
    await act(async () => root!.unmount());
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:voice" />));
    expect(controls.beginSend().hasSpeech).toBe(true);

    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument());
      controls.clearSpeechOriginWhenEmpty("");
      controls.replaceDocument(emptyDocument("typed only"));
    });
    expect(controls.beginSend().hasSpeech).toBeUndefined();

    act(() => controls.markSpeechOrigin());
    const send = controls.beginSend();
    expect(send.hasSpeech).toBe(true);
    expect(controls.completeSend(send)).toBe(true);
    controls.replaceDocument(emptyDocument("next typed message"));
    expect(controls.beginSend().hasSpeech).toBeUndefined();
  });

  it("keeps speech provenance only while a dictated span survives an edit", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:voice" />));
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("Dictated draft."));
      controls.markSpeechOrigin();
      controls.replaceDocument(emptyDocument("Typed replacement."), {
        start: 0,
        end: "Dictated draft.".length,
      });
    });
    expect(controls.beginSend().hasSpeech).toBeUndefined();

    act(() => {
      controls.replaceDocument(emptyDocument("Dictated draft."));
      controls.markSpeechOrigin();
      controls.replaceDocument(emptyDocument("Dictated draft!"), {
        start: "Dictated draft.".length,
        end: "Dictated draft.".length,
      });
    });
    expect(controls.beginSend().hasSpeech).toBe(true);
  });

  it("restores only persisted dictated spans from a mixed draft", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:mixed" />));
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("Typed prefix. Dictated words."));
      controls.markSpeechOrigin("Dictated words.");
    });
    expect(readComposerDraft("draft:mixed")?.speechRanges).toEqual([
      { position: "Typed prefix. ".length, length: "Dictated words.".length },
    ]);

    await act(async () => root!.unmount());
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:mixed" />));
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("Typed prefix. Typed replacement."), {
        start: "Typed prefix. ".length,
        end: "Typed prefix. Dictated words.".length,
      });
    });
    expect(controls.beginSend().hasSpeech).toBeUndefined();
  });

  it("keeps dictated ranges aligned through a format insertion before later deletion", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:format-edit" />));
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("Dictated words."));
      controls.markSpeechOrigin();
    });
    const snapshot = controls.getDocumentSnapshot();
    act(() => {
      controls.commitDocumentEdit(snapshot, (document) => {
        const transition = insertComposerFormat(
          document,
          0,
          { noun: "Document", icon: "fileText" },
          "Document ",
        );
        return transition;
      });
    });
    const afterFormatText = controls.document.text;
    const dictatedStart = afterFormatText.indexOf("Dictated words.");
    const serializedDraft = controls.beginSend().draft;
    expect(serializedDraft.speechRanges).toEqual([
      { position: serializedDraft.text.indexOf("Dictated words."), length: "Dictated words.".length },
    ]);
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument(
        afterFormatText.replace("Dictated words.", "typed replacement."),
      ), {
        start: dictatedStart,
        end: dictatedStart + "Dictated words.".length,
      });
    });
    expect(controls.beginSend().hasSpeech).toBeUndefined();
  });

  it("keeps persisted speech ranges aligned when restored format decoration adds text", async () => {
    const stored: StoredComposerDraft = {
      version: 1,
      text: "Create Document then spoken words.",
      formats: [{ position: 7, length: 8, noun: "Document", icon: "fileText" }],
      hasSpeech: true,
      speechRanges: [{ position: "Create Document then ".length, length: "spoken words.".length }],
    };
    writeComposerDraft("draft:decorated", stored);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:decorated" />));
    await act(async () => {
      iconState.resolve!("data:image/svg+xml,icon");
      await Promise.resolve();
    });
    const spokenStart = controls.document.text.indexOf("spoken words.");
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument(
        controls.document.text.replace("spoken words.", "typed replacement."),
      ), { start: spokenStart, end: spokenStart + "spoken words.".length });
    });
    expect(controls.beginSend().hasSpeech).toBeUndefined();
  });

  it("keeps speech between two restored format decorations", async () => {
    const text = "Document spoken words Table";
    const stored: StoredComposerDraft = {
      version: 1,
      text,
      formats: [
        { position: 0, length: "Document".length, noun: "Document", icon: "fileText" },
        { position: text.indexOf("Table"), length: "Table".length, noun: "Table", icon: "table" },
      ],
      hasSpeech: true,
      speechRanges: [{ position: "Document ".length, length: "spoken words".length }],
    };
    writeComposerDraft("draft:two-decorations", stored);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:two-decorations" />));
    await act(async () => {
      for (const resolve of iconState.resolves) resolve("data:image/svg+xml,icon");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(controls.document.text).toBe("\u2003\u2060\u00a0Document spoken words \u2003\u2060\u00a0Table");
    expect(controls.beginSend().hasSpeech).toBe(true);
    const spokenStart = controls.document.text.indexOf("spoken words");
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument(
        controls.document.text.replace("spoken words", "typed replacement"),
      ), { start: spokenStart, end: spokenStart + "spoken words".length });
    });
    expect(controls.beginSend().hasSpeech).toBeUndefined();
  });

  it("preserves the document revision when a late storage key is structurally identical", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    const snapshot = controls.getDocumentSnapshot();

    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));

    expect(controls.getDocumentSnapshot().documentRevision).toBe(snapshot.documentRevision);
    expect(controls.commitDocumentEdit(snapshot, () => ({
      document: emptyDocument("resource"),
    }))).not.toBeNull();
  });

  it("invalidates document snapshots when switching between identical keyed scopes", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));
    const snapshot = controls.getDocumentSnapshot();

    await act(async () => root!.render(<Harness storageKey="draft:user-b" />));

    expect(controls.getDocumentSnapshot().documentRevision).toBeGreaterThan(
      snapshot.documentRevision,
    );
    expect(controls.commitDocumentEdit(snapshot, () => ({
      document: emptyDocument("stale resource"),
    }))).toBeNull();
  });

  it("does not apply late draft decoration after an edit", async () => {
    const storedDraft: StoredComposerDraft = {
      version: 1,
      text: "Create a Document",
      formats: [{ position: 9, length: 8, noun: "Document", icon: "fileText" }],
    };
    writeComposerDraft("draft:user-a", storedDraft);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(
      <Harness storageKey="draft:user-a" />,
    ));
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("edited prompt"));
    });
    await act(async () => {
      iconState.resolve!("data:image/svg+xml,icon");
      await Promise.resolve();
    });

    expect(controls.document).toEqual(emptyDocument("edited prompt"));
  });

  it("allows presentation decoration to finish during a send", async () => {
    const storedDraft: StoredComposerDraft = {
      version: 1,
      text: "Create a Document",
      formats: [{ position: 9, length: 8, noun: "Document", icon: "fileText" }],
    };
    writeComposerDraft("draft:user-a", storedDraft);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));
    const send = controls.beginSend();
    await act(async () => {
      iconState.resolve!("data:image/svg+xml,icon");
      await Promise.resolve();
    });

    expect(controls.document.text).not.toBe(storedDraft.text);
    expect(controls.completeSend(send)).toBe(true);
    expect(readComposerDraft("draft:user-a")).toBeUndefined();
  });

  it("clears the sent scope without replacing a newly loaded scope", async () => {
    writeComposerDraft("draft:old", {
      version: 1,
      text: "sent prompt",
      formats: [],
    });
    writeComposerDraft("draft:new", {
      version: 1,
      text: "new scope prompt",
      formats: [],
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:old" />));
    const send = controls.beginSend();

    await act(async () => root!.render(<Harness storageKey="draft:new" />));

    expect(controls.completeSend(send)).toBe(false);
    expect(readComposerDraft("draft:old")).toBeUndefined();
    expect(controls.document.text).toBe("new scope prompt");
  });

  it("preserves a sent scope that was edited before another scope loaded", async () => {
    writeComposerDraft("draft:old", {
      version: 1,
      text: "sent prompt",
      formats: [],
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:old" />));
    const send = controls.beginSend();
    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("edited while sending"));
    });

    await act(async () => root!.render(<Harness storageKey="draft:new" />));

    expect(controls.completeSend(send)).toBe(false);
    expect(readComposerDraft("draft:old")?.text).toBe("edited while sending");
  });

  it("rejects an async document transition after a newer edit", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));
    const staleSnapshot = controls.getDocumentSnapshot();

    act(() => {
      controls.recordEdit();
      controls.replaceDocument(emptyDocument("newer prompt"));
    });
    let result: ReturnType<DraftControls["commitDocumentEdit"]>;
    act(() => {
      result = controls.commitDocumentEdit(staleSnapshot, () => ({
        document: emptyDocument("stale result"),
      }));
    });

    expect(result!).toBeNull();
    expect(controls.document.text).toBe("newer prompt");
  });

  it("rejects a positional transition after an unedited document replacement", async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));
    const staleSnapshot = controls.getDocumentSnapshot();

    act(() => controls.replaceDocument(emptyDocument("replacement")));

    expect(controls.commitDocumentEdit(staleSnapshot, () => ({
      document: emptyDocument("stale result"),
    }))).toBeNull();
    expect(controls.document.text).toBe("replacement");
  });

  it("allows a validated transition after presentation-only decoration", async () => {
    const storedDraft: StoredComposerDraft = {
      version: 1,
      text: "Create a Document at https://example.com",
      formats: [{ position: 9, length: 8, noun: "Document", icon: "fileText" }],
    };
    writeComposerDraft("draft:user-a", storedDraft);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness storageKey="draft:user-a" />));
    const snapshot = controls.getDocumentSnapshot();

    await act(async () => {
      iconState.resolve!("data:image/svg+xml,icon");
      await Promise.resolve();
    });

    expect(controls.commitDocumentEdit(snapshot, (document) => ({ document }), {
      allowPresentationChanges: true,
    })).not.toBeNull();
  });
});
