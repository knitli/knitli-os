// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => ({
  nextId: 0,
  uploadBlob: {
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as Blob,
}));

vi.mock("./prepareChatAttachment", () => ({
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES: 5 * 1024 * 1024,
  prepareChatAttachment: async (file: File) => ({
    blob: testState.uploadBlob,
    mimeType: file.type,
  }),
}));

import {
  useComposerAttachments,
  type ComposerAttachment,
} from "./useComposerAttachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return;
    await act(async () => Promise.resolve());
  }
  expect(check()).toBe(true);
};

describe("useComposerAttachments", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("stages uploads and clears only sent attachments", async () => {
    const uploadChatAttachment = vi.fn<Overseer["uploadChatAttachment"]>(
      async () => ({ id: `staged-${++testState.nextId}` }),
    );
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    const firstOverseer = {
      uploadChatAttachment,
      deleteChatAttachment,
    } as unknown as RpcStub<Overseer>;
    const onError = vi.fn<(message: string) => void>();
    let attachments: ComposerAttachment[] = [];
    let hasAttachments!: () => boolean;
    let addFiles: ((files: File[]) => Promise<void>) | undefined;
    let clearSentAttachments: ((sent: readonly ComposerAttachment[]) => void) | undefined;
    let removeAttachment: ((id: string) => void) | undefined;

    vi.stubGlobal("crypto", { randomUUID: () => `local-${++testState.nextId}` });
    const Harness = () => {
      const attachmentState = useComposerAttachments({
        getOverseer: () => firstOverseer,
        onError,
      });
      attachments = attachmentState.attachments;
      hasAttachments ??= attachmentState.hasAttachments;
      addFiles = attachmentState.addFiles;
      clearSentAttachments = attachmentState.clearSentAttachments;
      removeAttachment = attachmentState.removeAttachment;
      return null;
    };

    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));

    expect(hasAttachments()).toBe(false);
    await act(async () => {
      await addFiles!([new File(["one"], "one.txt", { type: "text/plain" })]);
      expect(attachments).toHaveLength(0);
      expect(hasAttachments()).toBe(true);
    });
    await waitFor(() => attachments[0]?.uploadState === "ready");
    expect(uploadChatAttachment).toHaveBeenCalledWith(
      { mimeType: "text/plain", content: Uint8Array.of(1, 2, 3, 4), name: "one.txt" }, null);
    expect(attachments[0].ref).toEqual({ id: expect.stringMatching(/^staged-/) });
    const sentSnapshot = [...attachments];

    await act(async () => addFiles!([
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]));
    await waitFor(() => attachments.length === 2 && attachments[1].uploadState === "ready");
    act(() => clearSentAttachments!(sentSnapshot));

    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe("two.txt");
    expect(onError).not.toHaveBeenCalled();

act(() => removeAttachment!(attachments[0].id));
    expect(attachments).toHaveLength(0);
    // A ready attachment removed before sending has its staged upload reclaimed.
    await waitFor(() => deleteChatAttachment.mock.calls.length === 1);
  });

  it.each([[true, []], [false, ["staged-1"]]])(
      "leaves a spreadsheet held by a send to it when the composer unmounts (delivered: %s)",
      async (delivered, deletedAfterSettle) => {
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    const overseer = {
      uploadChatAttachment: async () => ({ id: "staged-1" }),
      deleteChatAttachment,
    } as unknown as RpcStub<Overseer>;
    let state!: ReturnType<typeof useComposerAttachments>;
    vi.stubGlobal("crypto", { randomUUID: () => "local-sheet" });
    const Harness = () => {
      state = useComposerAttachments({ getOverseer: () => overseer, onError: vi.fn<(message: string) => void>() });
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () => state.addFiles([new File(["x"], "a.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })]));
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
    const overseer = {
      uploadChatAttachment,
      deleteChatAttachment,
    } as unknown as RpcStub<Overseer>;
    let addFiles!: (files: File[]) => Promise<void>;
    vi.stubGlobal("crypto", { randomUUID: () => "local-race" });

    const Harness = () => {
      ({ addFiles } = useComposerAttachments({
        getOverseer: () => overseer,
        onError: vi.fn<(message: string) => void>(),
      }));
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () => addFiles([
      new File(["one"], "one.txt", { type: "text/plain" }),
    ]));
    await waitFor(() => uploadChatAttachment.mock.calls.length === 1);

    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => finishUpload({ id: "staged-late" }));
    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    await waitFor(() => deleteChatAttachment.mock.calls.length === 1);
    expect(deleteChatAttachment).toHaveBeenCalledWith("staged-late");
  });
});
