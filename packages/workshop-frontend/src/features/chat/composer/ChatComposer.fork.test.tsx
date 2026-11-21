// @vitest-environment jsdom
// Fork-owned: the voice-conversation cases (controls, conversation draft), kept out of
// upstream's ChatComposer.test.tsx so that file stays byte-identical (docs/fork-maintenance.md,
// rule 4). The harness above the tests mirrors that file's.
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";

type TestToast = {
  title: string;
  description?: string;
  variant: string;
  timeout?: number;
  actions?: { children: string; onClick: () => void }[];
};

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: TestToast) => string>(() => "toast-1"),
  closeToast: vi.fn<(toastId?: string) => void>(),
  gatekeeperModalProps: undefined as undefined | {
    open: boolean;
    onCreated: (gatekeeper: unknown) => Promise<void>;
    initialVendorId?: string;
    initialResourceUrl?: string;
    initialResourceUrlPattern?: string;
    initialAccountId?: number;
  },
  capsuleOverlayProps: undefined as undefined | {
    url: string;
    onSelectAccount: (accountId: number, vendorId: string, resource: { urlPattern: string }) => void;
  },
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast, close: testState.closeToast }),
}));

vi.mock("../../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}));

vi.mock("../../../useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));

vi.mock("../../../CapsuleOverlay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../CapsuleOverlay")>()),
  default: (props: typeof testState.capsuleOverlayProps) => {
    testState.capsuleOverlayProps = props;
    return null;
  },
}));

vi.mock("../../../GatekeeperModal", () => ({
  default: (props: typeof testState.gatekeeperModalProps) => {
    testState.gatekeeperModalProps = props;
    return null;
  },
}));

import { ChatComposer } from "./ChatComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", TestResizeObserver);

class TestSpeechRecognition extends EventTarget {
  static current: TestSpeechRecognition;
  // An accessor, as the browser's: support is detected on the prototype.
  #processLocally = false;
  get processLocally() { return this.#processLocally; }
  set processLocally(value: boolean) { this.#processLocally = value; }
  interimResults = false;
  lang = "";
  start = vi.fn<() => void>(() => {
    TestSpeechRecognition.current = this;
    this.dispatchEvent(new Event("start"));
  });
  stop = vi.fn<() => void>();
  abort = vi.fn<() => void>();

  report(text: string) {
    this.dispatchEvent(Object.assign(new Event("result"), {
      resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }],
    }));
  }
}

describe("ChatComposer (fork)", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
    testState.addToast.mockClear();
    testState.closeToast.mockClear();
    testState.gatekeeperModalProps = undefined;
    testState.capsuleOverlayProps = undefined;
  });

  it("reads current draft eligibility even through a getter captured before an edit", async () => {
    let canStartConversation: (() => boolean) | undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ChatComposer
      createCapsuleGatekeeper={async () => null}
      getOverseer={() => ({} as RpcStub<Overseer>)} onSend={() => {}}
      isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
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
    let finishUpload: ((handle: { id: string }) => void) | undefined;
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const upload = vi.fn<() => Promise<{ id: string }>>(() => new Promise<{ id: string }>((resolve) => { finishUpload = resolve; }));
    const file = new File(["image"], "draft.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(5) });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    try {
      await act(async () => root!.render(<ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({ uploadChatAttachment: upload, deleteChatAttachment: async () => {} }) as unknown as RpcStub<Overseer>}
        onSend={() => {}} isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
        voiceControls={(draft) => { canStartConversation ??= draft.canStartConversation; return null; }}
      />));
      expect(canStartConversation!()).toBe(true);
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: [file] });
      await act(async () => {
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(canStartConversation!()).toBe(false);
      });
      expect(upload).toHaveBeenCalledOnce();
      expect(canStartConversation!()).toBe(false);
      await act(async () => finishUpload!({ id: "staged-draft" }));
      expect(canStartConversation!()).toBe(false);
      // The attachment tray renders once: a single remove control for the one attachment.
      expect(container.querySelectorAll('[aria-label="Remove draft.png"]')).toHaveLength(1);
      await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="Remove draft.png"]')!.click());
      expect(canStartConversation!()).toBe(true);
    } finally {
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      vi.unstubAllGlobals();
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
    }
  });

  it("edits and sends controlled conversation text through the main composer with original selections", async () => {
    const onSend = vi.fn<(text: string) => void>();
    const onChange = vi.fn<(text: string, selection?: { start: number; end: number }) => void>();
    const normalSend = vi.fn<() => void>();
    const Harness = ({ live = false }: { live?: boolean }) => {
      const [text, setText] = useState("First request\nSecond request");
      return <ChatComposer
        createCapsuleGatekeeper={async () => null} getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={normalSend} isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
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

  it("offers on-device voice typing beside the voice controls, and holds a conversation until its words are settled", async () => {
    vi.stubGlobal("webkitSpeechRecognition", TestSpeechRecognition);
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
    });
    let canStartConversation: (() => boolean) | undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ChatComposer
      createCapsuleGatekeeper={async () => null}
      getOverseer={() => ({} as RpcStub<Overseer>)} onSend={() => {}}
      isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
      voiceControls={(draft) => { canStartConversation ??= draft.canStartConversation; return null; }}
    />));
    const button = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(canStartConversation!()).toBe(true);

    await act(async () => button("Start voice typing")!.click());
    expect(canStartConversation!()).toBe(false);
    await act(async () => TestSpeechRecognition.current.report("make a chart"));
    await act(async () => button("Stop voice typing")!.click());
    await act(async () => TestSpeechRecognition.current.dispatchEvent(new Event("end")));
    // Stop adds the words to the draft, which a conversation waits on like any draft.
    expect(container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!.value).toBe("make a chart");
    expect(canStartConversation!()).toBe(false);
  });

  it("disables voice typing while a voice conversation holds the composer", async () => {
    vi.stubGlobal("webkitSpeechRecognition", TestSpeechRecognition);
    onTestFinished(() => {
      vi.unstubAllGlobals();
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ChatComposer
      createCapsuleGatekeeper={async () => null}
      getOverseer={() => ({} as RpcStub<Overseer>)} onSend={() => {}}
      isAgentActive={false} models={[]} selectedModel={{ id: "model-a" }} onModelChange={() => {}}
      conversationDraft={{ text: "", readOnly: true, canSend: false, onChange: () => {}, onSend: () => {} }}
    />));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Start voice typing"]')!.disabled).toBe(true);
  });

  it("blocks a voice conversation while a connection is added", async () => {
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
        selectedModel={{ id: "model-a" }}
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
