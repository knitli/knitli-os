// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, AiChatAuthorInfo, AiChatMessage, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: addToast }
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
  }
})

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [], listLibraryBlueprints: async () => [], getModelReasoning: async () => null },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

const voiceBoundary = vi.hoisted(() => ({
  start: vi.fn<(mode: string) => void>(),
  available: false,
  state: { mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "" } as import("./features/chat/voice/VoiceControls").VoiceControlsState,
}));
vi.mock('./features/chat/voice/useVoiceChat', () => ({
  useVoiceChat: (props: { conversationAvailable: boolean; sendMessage: (text: string, metadata: { hasSpeech: true }) => Promise<unknown> }) => {
    voiceBoundary.available = props.conversationAvailable;
    return {
      state: voiceBoundary.state,
      start: (mode: string) => { voiceBoundary.start(mode); void props.sendMessage("First spoken request", { hasSpeech: true }); }, end: () => {}, toggleMute: () => {}, setPendingText: () => {}, sendPending: () => {},
    };
  },
}));

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'
import { INCOMPLETE_DESCRIPTION_COPY } from './components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from './components/RestrictedApprovalNotice'
import { linkActionLog } from './useActions'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  voiceBoundary.state = { mode: null, status: "idle", muted: false, interimTranscript: null, error: null, pendingText: "" }
  vi.restoreAllMocks()
})

function withChatApi(
  server: ReturnType<typeof makeOverseer>,
  getChatMessage = vi.fn<(chatId: number, sequence: number) => Promise<AiChatMessage | null>>(),
  chats: AiChatMetadata[] = [],
) {
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => chats,
    listModels: async () => [],
    listPromptPresets: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
  })
  return {
    getChatMessage,
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
    },
  }
}

function renderChat(
  overseer: RpcStub<Overseer>,
  props: { restricted?: boolean, selectedChatId?: number, initialVoice?: { chatId: number; modelId: string; onConsumed: () => void } } = {},
) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      restricted={props.restricted}
      selectedChatId={props.selectedChatId ?? null}
      initialVoice={props.initialVoice}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
}

const actionMessage = {
  chatId: 1,
  sequence: 0,
  timestamp: new Date(),
  author: { type: 'agent', id: 'model', name: 'Model' },
  type: 'action',
  actionId: 1,
  actionLog: entry(1),
} as AiChatMessage

const resolvedMessage =
  { ...actionMessage, actionLog: entry(1, { state: 'approved' }) } as AiChatMessage

// Renders a first session that caches a pending action card, then settles it so a linked swap
// can resume. Pass a key to link the stub; unlinked sessions never park a watermark.
async function cachePendingCard(key?: string) {
  const first = makeOverseer()
  const firstChat = withChatApi(first)
  if (key !== undefined) linkActionLog(first.overseer, key)
  await renderChat(first.overseer)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1)] })
  firstChat.emitMessage(actionMessage)
}

describe('ChatInterface action refresh', () => {
  it('refetches cached mutable cards when an unlinked stub swaps', async () => {
    await cachePendingCard()

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    await renderChat(second.overseer)
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })

  it('skips the cached-card refetch on a resumed linked stub swap', async () => {
    await cachePendingCard('ws-chat-resume')

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    linkActionLog(second.overseer, 'ws-chat-resume')
    await renderChat(second.overseer)
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [entry(1)] })
    expect(secondChat.getChatMessage).not.toHaveBeenCalled()
  })
})

// A pending action whose description runs to several paragraphs: what the approver has to read
// in full when the workspace is restricted.
const longDescription = [
  'Send the following email to alice@example.com:',
  'Hi Alice, attached are the quarterly numbers you asked for.',
  'Regards, the workspace.',
].join('\n\n')

function pendingLog(over: Partial<Record<string, unknown>> = {}) {
  return entry(1, {
    description: { title: 'Send email', description: longDescription, implementsRevert: false, ...over },
  })
}

// Renders chat 1 selected, so its messages -- and the action card for `log` -- are actually on
// screen.
async function renderPendingCard(log: ActionLogEntry, props: { restricted?: boolean } = {}) {
  const server = makeOverseer()
  const chat = withChatApi(server, undefined, [
    { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
  ])
  await renderChat(server.overseer, { ...props, selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [log] })
  chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)
}

const clampedDescription = () => document.querySelector('[class*="max-h-[200px]"]')

// The text a screen reader announces as the Approve button's description.
function approveDescribedBy(): string | null {
  const approve = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')
  if (!approve) throw new Error('No Approve button rendered')
  const ids = approve.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('restricted approval', () => {
  it('shows the notice and the full request on a pending card while restricted', async () => {
    await renderPendingCard(pendingLog(), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(clampedDescription()).toBeNull()
    // The controls precede the review text in DOM order, so the buttons name it explicitly.
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('names only the restricted notice and request for a complete description', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }), { restricted: true })

    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows the notice and the full request on a blocking card while restricted', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).toBeNull()
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
  })

  it('names the fields as part of the request while restricted', async () => {
    const fields = [{ label: 'To', kind: 'list', items: ['a@example.com'] }]
    await renderPendingCard(pendingLog({ descriptionIsComplete: true, fields }), { restricted: true })

    expect(approveDescribedBy()).toContain('a@example.com')
  })

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} card's long fields without a scroll cap while restricted`, async () => {
      const fields = [{ label: 'Body', kind: 'text', value: 'Full body text' }]
      await renderPendingCard(pendingLog({ ...over, fields }), { restricted: true })

      const body = [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')
      expect(body?.className).not.toContain('max-h-56')
      expect(document.querySelector('[class*="max-h-[360px]"]')).toBeNull()
    })
  }

  it('keeps the scrolling description and no notice when not restricted', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).not.toBeNull()
    expect(approveDescribedBy()).toBeNull()
  })
})

describe('incomplete description notice', () => {
  it('flags a pending action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('flags a blocking action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }))

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows no notice when the description is complete', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }))

    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(document.body.textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })
})

describe('action fields', () => {
  const body = 'LGTM ```but``` <script>alert(1)</script>'
  const fields = [{ label: 'Body', kind: 'text', value: body, syntax: 'markdown' }]

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} action's fields as literal text after the description`, async () => {
      await renderPendingCard(pendingLog({ ...over, fields }))

      const pre = [...document.body.querySelectorAll('pre')].find(el => el.textContent === body)
      expect(pre).toBeDefined()
      expect(document.body.querySelector('script')).toBeNull()
      expect(document.body.textContent).toContain('Send the following email to alice@example.com:')
    })
  }
})


it('starts initial voice once after subscription and models are ready, preserving the chosen model for an empty chat', async () => {
  voiceBoundary.start.mockClear();
  const server = makeOverseer();
  const chat = withChatApi(server, undefined, [{ id: 0, title: "New Chat", started: new Date(), lastActive: new Date() }]);
  const sendChatMessage = vi.fn<Overseer["sendChatMessage"]>().mockResolvedValue(0);
  let resolveModels!: (models: AiChatAuthorInfo[]) => void;
  Object.assign(server.overseer, {
    sendChatMessage,
    listModels: () => new Promise<AiChatAuthorInfo[]>((resolve) => { resolveModels = resolve; }),
  });
  const consumed = vi.fn<() => void>();
  await renderChat(server.overseer, { selectedChatId: 0, initialVoice: { chatId: 0, modelId: "voice-model", onConsumed: consumed } });
  expect(voiceBoundary.start).not.toHaveBeenCalled();
  await act(async () => resolveModels([{ id: "default-model", name: "Default", type: "agent" }, { id: "voice-model", name: "Voice model", type: "agent" }]));
  expect(voiceBoundary.start).toHaveBeenCalledExactlyOnceWith("conversation");
  expect(consumed).toHaveBeenCalledOnce();
  expect(sendChatMessage).toHaveBeenCalledExactlyOnceWith(0, "First spoken request", "voice-model", undefined, undefined, undefined, true);
  await renderChat(server.overseer, { selectedChatId: 0 });
  expect(voiceBoundary.available).toBe(true);
  chat.emitMessage({ chatId: 0, sequence: 0, timestamp: new Date(), type: "message",
    message: "First spoken request", author: { type: "user", id: "user", name: "User" }, hasSpeech: true });
  flushFrames();
  expect(voiceBoundary.available).toBe(true);
  expect(voiceBoundary.start).toHaveBeenCalledOnce();
});


it('hides live conversation speech and restores unsent instructions in the main composer after End or failure', async () => {
  const server = makeOverseer();
  withChatApi(server);
  voiceBoundary.state = { mode: "conversation", status: "listening", muted: false,
    interimTranscript: "Still speaking", pendingText: "Queued instruction", error: null };
  await renderChat(server.overseer, { selectedChatId: 0 });
  const editor = () => document.body.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')!;
  expect(editor().value).toBe("");
  expect(editor().readOnly).toBe(true);
  expect(document.body.textContent).not.toContain("Still speaking");
  expect(document.body.textContent).not.toContain("Queued instruction");

  voiceBoundary.state = { ...voiceBoundary.state, mode: null, interimTranscript: null,
    pendingText: "Queued instruction\nStill speaking" };
  await renderChat(server.overseer, { selectedChatId: 0 });
  expect(editor().value).toBe("Queued instruction\nStill speaking");
  expect(editor().readOnly).toBe(false);

  voiceBoundary.state = { ...voiceBoundary.state, mode: "conversation", error: "Message was not sent" };
  await renderChat(server.overseer, { selectedChatId: 0 });
  expect(editor().value).toBe("Queued instruction\nStill speaking");
  expect(editor().readOnly).toBe(false);
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("Message was not sent");
});
// The server's refusal for a chat whose model an administrator disabled.
const disabledModel = 'The "Kimi K3" model is disabled on this deployment by an administrator.'

const openChat = { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() }

// Types into the composer on screen and submits it with Enter.
async function sendFromComposer(text: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')
  if (!textarea) throw new Error('No composer rendered')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  return textarea
}

describe('send and retry failures', () => {
  beforeEach(() => {
    addToast.mockClear()
    // Each failure is logged as well as shown.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  it('says why a message could not be sent and keeps it in the composer', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [openChat])
    Object.assign(server.overseer as object, {
      sendChatMessage: async () => { throw new Error(disabledModel) },
    })
    await renderChat(server.overseer, { selectedChatId: 1 })

    const textarea = await sendFromComposer('Summarize the report')

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to send message', description: disabledModel, variant: 'error' })
    expect(textarea.value).toBe('Summarize the report')
  })

  it('says why a conversation could not be started', async () => {
    const server = makeOverseer()
    withChatApi(server)
    Object.assign(server.overseer as object, {
      newChat: async () => { throw new Error(disabledModel) },
    })
    await renderChat(server.overseer)

    const textarea = await sendFromComposer('Summarize the report')

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to start conversation', description: disabledModel, variant: 'error' })
    expect(textarea.value).toBe('Summarize the report')
  })

  it('raises no toast for a send the connection dropped', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [openChat])
    const sendChatMessage = vi.fn<() => Promise<void>>(async () => {
      throw new Error('Peer closed WebSocket: 1006 ')
    })
    Object.assign(server.overseer as object, { sendChatMessage })
    await renderChat(server.overseer, { selectedChatId: 1 })

    const textarea = await sendFromComposer('Summarize the report')

    expect(sendChatMessage).toHaveBeenCalledOnce()
    expect(addToast).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Summarize the report')
  })

  // Renders chat 1 ending in an agent error, then presses its Retry.
  async function retryAfterError(retryAgent: () => Promise<void>) {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [openChat])
    Object.assign(server.overseer as object, { retryAgent })
    await renderChat(server.overseer, { selectedChatId: 1 })
    chat.emitMessage({
      chatId: 1,
      sequence: 0,
      timestamp: new Date(),
      author: { type: 'agent', id: 'model', name: 'Model' },
      type: 'error',
      message: 'The model request failed.',
    })
    const retry = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry')
    if (!retry) throw new Error('No Retry button rendered')
    await act(async () => retry.click())
  }

  it('says why a retry failed', async () => {
    await retryAfterError(async () => { throw new Error(disabledModel) })

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to retry agent', description: disabledModel, variant: 'error' })
  })

  it('reports a retry the connection dropped without the transport message', async () => {
    await retryAfterError(async () => { throw new Error('Peer closed WebSocket: 1006 ') })

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to retry agent', description: undefined, variant: 'error' })
  })
})
