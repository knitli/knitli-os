// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  gatekeeperModalProps: undefined as undefined | {
    open: boolean;
    onCreated: (gatekeeper: unknown) => Promise<void>;
  },
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("../../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}));

vi.mock("../../../useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));

vi.mock("../../../GatekeeperModal", () => ({
  default: (props: typeof testState.gatekeeperModalProps) => {
    testState.gatekeeperModalProps = props;
    return null;
  },
}));

import { ChatComposer } from "./ChatComposer";
import { useDictationAppendQueue } from "./useDictationAppendQueue";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", TestResizeObserver);

describe("ChatComposer", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
    testState.addToast.mockClear();
    testState.gatekeeperModalProps = undefined;
  });

  it("reads current draft eligibility even through a getter captured before an edit", async () => {
    let canStartConversation: (() => boolean) | undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ChatComposer
      createCapsuleGatekeeper={async () => null}
      getOverseer={() => ({} as RpcStub<Overseer>)} onSend={() => {}}
      isAgentActive={false} models={[]} selectedModel="model-a" onModelChange={() => {}}
      voiceControls={(draft) => { canStartConversation ??= draft.canStartConversation; return null; }}
    />));
    expect(canStartConversation!()).toBe(true);
    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    for (const value of ["Keep this draft", "   "]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        expect(canStartConversation!()).toBe(value.trim() === "");
      });
    }
  });

  it("blocks conversation while an attachment is prepared and uploaded, until removed", async () => {
    let canStartConversation: (() => boolean) | undefined;
    let finishPreparation: ((bitmap: ImageBitmap) => void) | undefined;
    let finishUpload: ((value: { id: string; mimeType: string; size: number }) => void) | undefined;
    const bitmap = { width: 10, height: 10, close: vi.fn<() => void>() } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn<() => Promise<ImageBitmap>>(() => new Promise<ImageBitmap>((resolve) => { finishPreparation = resolve; })));
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const upload = vi.fn<() => Promise<{ id: string; mimeType: string; size: number }>>(() => new Promise<{ id: string; mimeType: string; size: number }>((resolve) => { finishUpload = resolve; }));
    const remove = vi.fn<(id: string) => Promise<void>>(async () => {});
    const file = new File(["image"], "draft.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(5) });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    try {
      await act(async () => root!.render(<ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({ uploadChatAttachment: upload, deleteChatAttachment: remove }) as unknown as RpcStub<Overseer>}
        onSend={() => {}} isAgentActive={false} models={[]} selectedModel="model-a" onModelChange={() => {}}
        voiceControls={(draft) => { canStartConversation ??= draft.canStartConversation; return null; }}
      />));
      expect(canStartConversation!()).toBe(true);
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: [file] });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(canStartConversation!()).toBe(false);
      });
      expect(upload).not.toHaveBeenCalled();
      await act(async () => finishPreparation!(bitmap));
      expect(upload).toHaveBeenCalledOnce();
      expect(canStartConversation!()).toBe(false);
      await act(async () => finishUpload!({ id: "staged", mimeType: "image/png", size: 5 }));
      expect(canStartConversation!()).toBe(false);
      expect(remove).not.toHaveBeenCalled();
      await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Remove attachment"]')!.click());
      expect(canStartConversation!()).toBe(true);
      expect(remove).toHaveBeenCalledExactlyOnceWith("staged");
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      vi.unstubAllGlobals();
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
    }
  });

  it("replaces live dictation in the real composer without overwriting edits or resurrecting sent speech", async () => {
    let dictation!: ReturnType<typeof useDictationAppendQueue>;
    const onSend = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    const DictationComposer = () => {
      dictation = useDictationAppendQueue();
      return <ChatComposer
        chatKey={7}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={onSend}
        appendText={dictation.appendForChat(7)}
        onAppendTextApplied={dictation.acknowledge}
        isAgentActive={false} models={[]} selectedModel="model-a" onModelChange={() => {}}
      />;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<DictationComposer />));
    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const edit = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await edit("Typed draft");
    await act(async () => dictation.enqueue("First", 7, 1, false));
    expect(textarea.value).toBe("Typed draft\nFirst");
    textarea.focus();
    textarea.setSelectionRange(0, 5);
    await act(async () => {
      dictation.enqueue("First sentence", 7, 1, false);
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 5]);
    expect(textarea.value).toBe("Typed draft\nFirst sentence");
    await edit("Edited draft\nFirst sentence");
    await edit("Edited draft\nFirst sentence and typed suffix");
    await act(async () => dictation.enqueue("First sentence.", 7, 1, true));
    expect(textarea.value).toBe("Edited draft\nFirst sentence. and typed suffix");
    await act(async () => dictation.enqueue("Second mistake", 7, 2, false));
    await edit("Edited draft\nFirst sentence. and typed suffix\nSecond correction");
    await act(async () => dictation.enqueue("Second mistake.", 7, 2, true));
    expect(textarea.value).toBe("Edited draft\nFirst sentence. and typed suffix\nSecond correction");
    await act(async () => dictation.enqueue("Third", 7, 3, false));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(onSend).toHaveBeenCalledOnce();
    expect(onSend.mock.calls[0][0]).toBe("Edited draft\nFirst sentence. and typed suffix\nSecond correction\nThird");
    expect(onSend.mock.calls[0].at(-1)).toEqual({ hasSpeech: true });
    expect(textarea.value).toBe("");
    await act(async () => dictation.enqueue("Third sentence.", 7, 3, true));
    expect(textarea.value).toBe("");
    await act(async () => dictation.enqueue("Fourth", 7, 4, false));
    await edit("Entirely typed replacement");
    await act(async () => dictation.enqueue("Fourth sentence.", 7, 4, true));
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(onSend.mock.calls[1][0]).toBe("Entirely typed replacement");
    expect(onSend.mock.calls[1].at(-1)).not.toEqual({ hasSpeech: true });
    await act(async () => dictation.enqueue("Stop keeps this", 7, 5, false));
    await act(async () => dictation.enqueue("Stop keeps this", 7, 5, true));
    expect(textarea.value).toBe("Stop keeps this");
    await act(async () => dictation.enqueue("Duplicate late final", 7, 5, true));
    expect(textarea.value).toBe("Stop keeps this");
  });

  it("edits and sends controlled conversation text through the main composer with original selections", async () => {
    const onSend = vi.fn<(text: string) => void>();
    const onChange = vi.fn<(text: string, selection?: { start: number; end: number }) => void>();
    const normalSend = vi.fn<() => void>();
    const Harness = ({ live = false }: { live?: boolean }) => {
      const [text, setText] = useState("First request\nSecond request");
      return <ChatComposer
        createCapsuleGatekeeper={async () => null} getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={normalSend} isAgentActive={false} models={[]} selectedModel="model-a" onModelChange={() => {}}
        conversationDraft={{ text, readOnly: live, canSend: !live,
          onChange: (value, selection) => { onChange(value, selection); setText(value); },
          onSend: () => onSend(text),
        }}
      />;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness live />));
    const editor = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    expect(editor.value).toBe("First request\nSecond request");
    expect(editor.readOnly).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
    await act(async () => root!.render(<Harness />));
    expect(editor.readOnly).toBe(false);
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    editor.focus();
    editor.setSelectionRange(0, 5);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      setValue.call(editor, "Typed request\nSecond request");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("Typed request\nSecond request", { start: 0, end: 5 });
    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(onSend).toHaveBeenCalledExactlyOnceWith("Typed request\nSecond request");
    expect(editor.value).toBe("Typed request\nSecond request");
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(normalSend).not.toHaveBeenCalled();
  });

  it("keeps dictation read-only until Stop, then sends the complete latest transcript", async () => {
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(async () => {});
    const upload = vi.fn<() => Promise<never>>();
    let dictation!: ReturnType<typeof useDictationAppendQueue>;
    const Harness = ({ recording }: { recording: boolean }) => {
      dictation = useDictationAppendQueue();
      return <ChatComposer
        chatKey={7} isDictating={recording}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({ uploadChatAttachment: upload }) as unknown as RpcStub<Overseer>}
        onSend={onSend} isAgentActive={false} models={[]} selectedModel="model-a" onModelChange={() => {}}
        appendText={dictation.appendForChat(7)} onAppendTextApplied={dictation.acknowledge}
      />;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<Harness recording />));
    await act(async () => dictation.enqueue("First words", 7, 1, false));
    const editor = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    expect(editor.readOnly).toBe(true);
    expect(editor.disabled).toBe(false);
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(true);
    const file = new File(["text"], "note.txt", { type: "text/plain" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(4) });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      send.click();
    });
    expect(upload).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => dictation.enqueue("First words and the complete sentence.", 7, 1, false));
    await act(async () => {
      dictation.enqueue("First words and the complete sentence.", 7, 1, true);
      root!.render(<Harness recording={false} />);
    });
    expect(editor.value).toBe("First words and the complete sentence.");
    expect(editor.readOnly).toBe(false);
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(onSend).toHaveBeenCalledExactlyOnceWith("First words and the complete sentence.", "model-a", undefined, undefined, undefined, { hasSpeech: true });
  });

  it("appends two finalized dictation segments batched before the composer effect", async () => {
    let dictation: ReturnType<typeof useDictationAppendQueue> | undefined;
    const DictationComposer = () => {
      dictation = useDictationAppendQueue();
      return <ChatComposer
        chatKey={7}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        appendText={dictation.appendForChat(7)}
        onAppendTextApplied={dictation.acknowledge}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<DictationComposer />));

    await act(async () => {
      dictation!.enqueue("First dictated segment.", 7);
      dictation!.enqueue("Second dictated segment.", 7);
    });

    expect(container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!.value)
      .toBe("First dictated segment.\nSecond dictated segment.");
  });

  it("keeps a late dictation segment with its originating chat", async () => {
    let dictation: ReturnType<typeof useDictationAppendQueue> | undefined;
    const DictationComposer = ({ chatKey }: { chatKey: number }) => {
      dictation = useDictationAppendQueue();
      return <ChatComposer
        key={chatKey}
        chatKey={chatKey}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        appendText={dictation.appendForChat(chatKey)}
        onAppendTextApplied={dictation.acknowledge}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />;
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<DictationComposer chatKey={7} />));

    await act(async () => {
      dictation!.enqueue("For chat seven.", 7);
      root!.render(<DictationComposer chatKey={8} />);
    });
    await act(async () => dictation!.enqueue("For chat eight.", 8));
    expect(container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!.value)
      .toBe("For chat eight.");

    await act(async () => root!.render(<DictationComposer chatKey={7} />));
    expect(container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!.value)
      .toBe("For chat seven.");
  });

  it.each([
    ["typing", "Typed replacement."],
    ["pasting", "Pasted replacement."],
  ])("does not send speech provenance after select-all %s replaces dictated text", async (
      _method, replacement) => {
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(async () => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        chatKey={7}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={onSend}
        appendText={{ token: 1, text: "Dictated draft.", chatKey: 7 }}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />,
    ));
    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    expect(textarea.value).toBe("Dictated draft.");

    await act(async () => {
      textarea.setSelectionRange(0, textarea.value.length);
      textarea.dispatchEvent(new KeyboardEvent("keydown", {
        key: _method === "typing" ? "T" : "v", ctrlKey: _method === "pasting", bubbles: true,
      }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea, replacement,
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(replacement, "model-a", undefined, undefined, undefined);
  });

  it("retains speech provenance after a partial edit of dictated text", async () => {
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(async () => {});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        chatKey={7}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={onSend}
        appendText={{ token: 1, text: "Dictated draft.", chatKey: 7 }}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />,
    ));
    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "!", bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea, "Dictated draft!",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      "Dictated draft!", "model-a", undefined, undefined, undefined, { hasSpeech: true },
    );
  });

  it("sends on Enter without clearing document changes made while sending", async () => {
    let finishSend: (() => void) | undefined;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(
      () => new Promise<void>((resolve) => { finishSend = resolve; }),
    );
    const overseer = {} as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "  Build a dashboard  ",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      "Build a dashboard",
      "model-a",
      undefined,
      undefined,
      undefined,
    );
    expect(textarea.disabled).toBe(false);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Next question",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => finishSend!());
    expect(textarea.value).toBe("Next question");
    expect(textarea.disabled).toBe(false);
    expect(testState.addToast).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error("Peer closed WebSocket"), transient: true },
    { error: new Error("send rejected"), transient: false },
  ])("preserves the draft after a failed send", async ({ error, transient }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(async () => {
      throw error;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
        chatKey={7}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Keep this draft",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(textarea.value).toBe("Keep this draft");
    expect(container.textContent?.includes("Connection hiccup")).toBe(transient);
    expect(consoleError).toHaveBeenCalledTimes(transient ? 0 : 1);
    consoleError.mockRestore();
  });
  it("keeps add-menu actions enabled after inserting a skill and removes the legacy button", async () => {
    const skill = {
      selection: { gatekeeperId: 42, commandId: "review" },
      name: "review",
      description: "Review the current project.",
      providerLabel: "Projects",
    };
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [skill]);
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
        attachLabel="Legacy resource"
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "before after",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    textarea.setSelectionRange(7, 7);
    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!;
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .some((option) => option.textContent?.includes("review")),
    ).toBe(true)));
    const skillOption = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("review"))!;
    await act(async () => {
      skillOption.click();
      await new Promise(requestAnimationFrame);
    });

    expect(textarea.value).toBe("before /review after");
    expect(document.body.textContent)
      .toContain("Slash command /review from Projects is ready to send");
    expect(document.activeElement).toBe(textarea);

    await act(async () => add.click());
    const actions = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => !action.disabled)).toBe(true);
    expect(document.querySelector('[aria-label="Search skills"]')).toBeNull();
    expect(container.textContent).not.toContain("Add resource");
    expect(container.textContent).not.toContain("Legacy resource");
    const connection = actions.find((action) => action.textContent?.includes("Add a new connection"))!;
    await act(async () => connection.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);
    expect(listSlashCommands).toHaveBeenCalledTimes(1);
  });

  it("sends unconfirmed slash text as plain text", async () => {
    const skill: SlashCommandChoice = {
      selection: { gatekeeperId: 42, commandId: "deploy" },
      name: "deploy",
      description: "Deploy the current project.",
      providerLabel: "Projects",
    };
    const overseer = {
      listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [skill]),
    } as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "/deploy production",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      "/deploy production",
      "model-a",
      undefined,
      undefined,
      undefined,
    );
  });

  it("sends double slash as literal text without opening the skill picker", async () => {
    const overseer = {
      listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => []),
    } as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={null}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "//deploy literally",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(overseer.listSlashCommands).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      "//deploy literally", null, undefined, undefined, undefined,
    );
  });

  it("invalidates and refetches skills after adding a connection", async () => {
    let canStartConversation: (() => boolean) | undefined;
    const firstSkill = {
      selection: { gatekeeperId: 1, commandId: "first" },
      name: "first skill",
      description: "Initially connected.",
      providerLabel: "Tools",
    };
    const nextSkill = {
      ...firstSkill,
      selection: { gatekeeperId: 2, commandId: "next" },
      name: "new connection skill",
    };
    let catalog = [firstSkill];
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => catalog);
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        voiceControls={(draft) => { canStartConversation ??= draft.canStartConversation; return null; }}
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel="model-a"
        onModelChange={() => {}}
      />,
    ));

    expect(canStartConversation!()).toBe(true);
    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!;
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(document.body.textContent).toContain("first skill")));
    const connect = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Add a new connection"))!;
    await act(async () => connect.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);
    expect(canStartConversation!()).toBe(false);

    catalog = [firstSkill, nextSkill];
    const gatekeeper = {
      getId: async () => 9,
      describe: async () => ({ title: "Project", url: "https://example.com/project" }),
      getCreationSpec: async () => ({ type: "gatekeeper", vendorId: "example" }),
      [Symbol.dispose]: vi.fn<() => void>(),
    };
    await act(async () => {
      await testState.gatekeeperModalProps!.onCreated(gatekeeper);
      await new Promise(requestAnimationFrame);
    });

    expect(canStartConversation!()).toBe(false);
    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const resourceEnd = textarea.value.indexOf("Project") + "Project".length;
    textarea.setSelectionRange(resourceEnd, resourceEnd);
    await act(async () => textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    ));
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(document.body.textContent)
      .toContain("new connection skill")));
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });
});
