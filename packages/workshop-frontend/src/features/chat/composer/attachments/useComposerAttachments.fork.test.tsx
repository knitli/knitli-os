// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Fork cases: a spreadsheet is staged whole (uploadChatAttachment) and reclaimed if never sent,
// while every other file takes upstream's streamed uploadBlob() path, which upstream's
// useComposerAttachments.test.tsx covers.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";

const SHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const testState = vi.hoisted(() => ({
  uploadBlob: {
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3, 4));
        controller.close();
      },
    }),
  } as Blob,
}));

vi.mock("./prepareChatAttachment", () => ({
  prepareChatAttachment: async (file: File) => ({
    blob: testState.uploadBlob,
    mimeType: file.type,
  }),
}));

import { useComposerAttachments } from "./useComposerAttachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return;
    await act(async () => Promise.resolve());
  }
  expect(check()).toBe(true);
};

describe("useComposerAttachments (staged spreadsheets)", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let state!: ReturnType<typeof useComposerAttachments>;

  const mount = async (overseer: Partial<Record<keyof Overseer, unknown>>) => {
    const Harness = () => {
      state = useComposerAttachments({
        getOverseer: () => overseer as unknown as RpcStub<Overseer>,
        onError: vi.fn<(message: string) => void>(),
      });
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
  };

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("stages a spreadsheet, streams any other file, and reclaims only the staged one", async () => {
    const uploadChatAttachment = vi.fn<Overseer["uploadChatAttachment"]>(async () => ({ id: "staged-1" }));
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    const uploadBlob = vi.fn<Overseer["uploadBlob"]>(async (content) => {
      // Drain it, as the server does: the upload settles only once the stream has been read.
      if (!(content instanceof Uint8Array)) for await (const _chunk of content.stream) { /* drain */ }
      return "a".repeat(40);
    });
    let nextId = 0;
    vi.stubGlobal("crypto", { randomUUID: () => `local-${++nextId}` });
    await mount({ uploadChatAttachment, deleteChatAttachment, uploadBlob });

    expect(state.hasAttachments()).toBe(false);
    await act(async () => state.addFiles([
      new File(["x"], "a.xlsx", { type: SHEET }),
      new File(["one"], "one.txt", { type: "text/plain" }),
    ]));
    expect(state.hasAttachments()).toBe(true);
    await waitFor(() => state.attachments.length === 2
      && state.attachments.every((attachment) => attachment.uploadState === "ready"));

    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(uploadChatAttachment).toHaveBeenCalledWith(
      { mimeType: SHEET, content: Uint8Array.of(1, 2, 3, 4), name: "a.xlsx" }, null);
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    expect(state.attachments.map((attachment) => attachment.ref)).toEqual([
      { id: "staged-1" },
      { oid: "a".repeat(40), mimeType: "text/plain", name: "one.txt" },
    ]);

    // Removing each before a send reclaims the staged upload; a blob has nothing to reclaim.
    const [sheet, text] = state.attachments;
    act(() => state.removeAttachment(text.id));
    act(() => state.removeAttachment(sheet.id));
    await waitFor(() => deleteChatAttachment.mock.calls.length === 1);
    expect(deleteChatAttachment).toHaveBeenCalledWith("staged-1");
  });

  it.each([[true, []], [false, ["staged-1"]]])(
      "leaves a spreadsheet held by a send to it when the composer unmounts (delivered: %s)",
      async (delivered, deletedAfterSettle) => {
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    vi.stubGlobal("crypto", { randomUUID: () => "local-sheet" });
    await mount({ uploadChatAttachment: async () => ({ id: "staged-1" }), deleteChatAttachment });
    await act(async () => state.addFiles([new File(["x"], "a.xlsx", { type: SHEET })]));
    await waitFor(() => state.attachments[0]?.uploadState === "ready");

    const release = state.holdForSend(state.attachments);
    await act(async () => root!.unmount());
    root = undefined;
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    await act(async () => release(delivered));
    expect(deleteChatAttachment.mock.calls.map(([id]) => id)).toEqual(deletedAfterSettle);
  });

  it("reclaims a staged upload that finishes after the composer unmounts", async () => {
    let finishUpload!: (handle: { id: string }) => void;
    const uploadChatAttachment = vi.fn<Overseer["uploadChatAttachment"]>(
      () => new Promise((resolve) => { finishUpload = resolve; }),
    );
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    vi.stubGlobal("crypto", { randomUUID: () => "local-race" });
    await mount({ uploadChatAttachment, deleteChatAttachment });
    await act(async () => state.addFiles([new File(["x"], "a.xlsx", { type: SHEET })]));
    await waitFor(() => uploadChatAttachment.mock.calls.length === 1);

    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => finishUpload({ id: "staged-late" }));
    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    await waitFor(() => deleteChatAttachment.mock.calls.length === 1);
    expect(deleteChatAttachment).toHaveBeenCalledWith("staged-late");
  });
});
