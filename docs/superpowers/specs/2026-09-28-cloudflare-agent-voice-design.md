# Cloudflare Agents voice for Knitli OS

Status: first version implemented on feat/workshop-voice. Automated validation passes; live microphone and hosted-model acceptance remains to be performed.

## Confirmed decisions

- Use Cloudflare Agents voice as the first integration candidate. The user selected
  it as a lighter-weight addition that may serve either as an interim solution or
  the final implementation.
- Speaking over the agent stops spoken playback, **not agent work**. The user
  explicitly selected “Stop speech; keep work running.” The existing explicit
  Stop action remains the way to cancel work.
- Keep voice attached to the existing OS agent/chat, permissions, and tool execution.
- The user approved the first-version scope, including visible queued instructions
  while the chat's agent is busy ("that's fine for now"). Live steering and a
  separate conversational controller are deferred.
- The user additionally required a distinction between **dictation** and
  **conversation**. The proposed behavior below was reflected back explicitly:
  dictation edits the composer with manual Send; conversation submits speech and
  speaks replies. Do not collapse these into one ambiguous microphone control.
- The user requires an appended model-facing transcription note for messages
  originating in either Dictate or Conversation, including manually sent dictation.
- The failed Pipecat/Python Workers spike was discarded at the user's request.

## Intended first experience

Choose Dictate or Conversation in the current agent's chat:

- **Dictate:** append finalized speech to the existing editable message composer.
  Do not send automatically, queue an automatic submission, start agent work, or
  synthesize a reply. Existing Send stays explicit. Dictation may continue while
  the agent is busy; ordinary chat rules still govern manual submission.
- **Conversation:** submit finalized speech automatically when idle, or show it
  as a pending instruction while busy, and speak assistant replies. Show
  listening/thinking/speaking state and transcript with mute/end-call controls.

Make the active mode visible. Switching modes ends the old audio session first,
preserves text in the composer/pending draft, and never implicitly submits that
text. Require explicit Send or a fresh conversational utterance before authorizing
submission; a fresh utterance must not silently submit an older preserved draft.
Speech interruption in Conversation clears pending spoken output while existing
agent work continues. Ending either mode releases the microphone and audio
connection without cancelling work.

### Transcription context in the submitted prompt

Append this note once when submitting a message containing dictated text, in
either mode, through the existing chat prompt construction path:

> Input context: This message includes speech transcribed from audio and may
> have been edited by the user. Transcription can mishear words, names, technical
> terms, or punctuation. Interpret it in context; if ambiguity materially affects
> the requested action, ask for clarification rather than guessing.

Keep the note out of the editable composer and spoken output. Track speech origin
alongside the draft so manual Send, edits, queuing, and mode changes retain it.
Clear it when the draft is sent or discarded; purely typed messages receive no
note. Mixed typed/dictated drafts receive the same single note. This is input
context only: it does not grant authority or bypass normal approvals.

## Proposed scope

Use the installed, pinned `agents@0.24.0` voice implementation for microphone
capture, transcription, sentence synthesis, playback, and interruption detection.
Begin with its Workers AI Flux STT and Aura TTS adapters. The SDK is MIT; these
defaults call hosted models with separate terms and usage charges. The existing
chat's chosen LLM and effort settings remain in effect.

The first version offers Dictate and Conversation in the trusted Workshop UI, with
explicit controls, visible state/transcript, mute, and stop/end controls. It does not add
telephone support, a new agent executor, or a voice-only tool approval mechanism.
Existing approval cards remain actionable in the normal chat UI.

### Busy chat behavior: approved for the first version

OS currently rejects `sendChatMessage` while that chat's `activeAgent` exists.
Therefore a new spoken instruction received during ongoing work becomes a
visible, editable pending draft. Additional speech appends to that draft; it must
not silently overwrite prior words. Submit once the chat becomes idle, provided
the same voice session and chat are still active. Cancel submission on chat
switch, call end, or connection loss, retaining the draft for explicit review.
Never automatically retry a submission whose outcome is unknown.

This keeps work running but does not let the same agent answer a second question
concurrently. Supporting live steering or a separate conversational controller
would be a larger, separately scoped change.

## Integration

Implemented flow:

```text
Microphone <-> Cloudflare voice connection (STT/TTS)
                      |
                 Workshop browser
                      |
            existing authorized chat RPC
                      |
            current OS agent and tools
```

The browser retains its existing authenticated `Overseer` capability and owns
the bridge between voice events and chat events. The voice service handles audio
and text; it receives no account login token or broad agent/tool capability.
This preserves the existing chat submission, subscription, permission, and
revocation paths rather than granting a second server independent agent authority.

Use a small voice Durable Object with `withVoice(Agent)`. Its `onTurn` emits a
correlated transcript event to its single authorized browser connection and
consumes that browser's normalized response-text stream. The browser submits the
transcript through the existing chat API, then forwards only the matching new
assistant response. Authenticate voice-session creation through the existing
authenticated API. The resulting short-lived, session-scoped connection capability
authorizes audio access only; do not route publicly by a guessed chat ID. Reject
missing, expired, reused, or cross-session connection credentials before accepting
audio or starting inference. Apply the existing origin/auth rules to the new route.

Bind the session to its chosen mode when it is created. In Dictate mode, emit
transcription events only and never enter the conversation/TTS path; the browser
must not be able to promote the session by sending a different message type.
Reuse the SDK's transcription machinery rather than implementing a second STT
client. A mode switch obtains a fresh session after closing the previous one.

Tie the voice connection to the authenticated browser session; end it when that
session is lost. Correlate messages to the active call, chat, and turn; reject
stale or out-of-order output. Bound accepted audio/text payloads and clean up
STT/TTS sessions, streams, and subscriptions on disconnect. Reconnection requires
a fresh voice session and does not automatically replay prior turns.

Only normal assistant text is eligible for speech. Do not read reasoning, tool
arguments, or code-execution events aloud. Reuse existing event classification;
validate how mixed prose/code in assistant text should be projected during the
first integrated test. Subscribe before submitting and reconcile provisional
deltas with committed messages and stream-generation changes without speaking
the same answer twice.

## Interruption and history

- Voice abort signals cancel only the voice stream, synthesis, and playback.
  They must not call `stopAgent` or abort the underlying OS execution.
- On barge-in, invalidate buffered audio and suppress the remainder of that
  spoken response. The chat continues receiving the agent's work and text.
- The stock client accepts untagged binary audio even after locally clearing
  playback. An ordered interruption acknowledgment and transport-level playback
  gate must reject late frames from the interrupted response before newer audio
  is admitted. Prove this with deliberately delayed audio frames; local queue
  clearing alone is insufficient. This may require a narrow client adapter.
- An aborted voice stream must settle any pending iterator read and detach voice
  forwarding immediately, even while OS tools are silent. The SDK's own abort
  check waits for the iterator to produce another event. Keep the normal chat
  subscription and work alive. Pending draft state outlives replacement voice
  turns and must not be discarded when their iterators close.
- Only explicit Stop work invokes the existing `stopAgent(chatId)` path. Wait
  for actual idle metadata before sending a pending draft; the stop RPC itself
  signals cancellation without waiting for completion.
- OS chat remains the authoritative record. Its generated answer may include
  text that was not heard; do not label the chat transcript as proof of playback.
- Suppress the SDK's parallel voice-message history by overriding its public
  `saveMessage` and `getConversationHistory` methods. The installed version
  dispatches these virtually; protect this contract with a pinned-SDK check.
  A zero history limit does not disable the SDK's writes.

## Integration traps verified in source

- `withVoice` intercepts `text_message` even outside an active call.
  `beforeCallStart` alone is insufficient authorization. Protect the connection
  and every browser-to-voice message, including this alternative entry point.
- Normalize OS events explicitly into an async text stream. Do not depend on
  the SDK's limited generic SSE parser.
- Aura buffers individual synthesized sentences. Measure first-audio delay;
  sentence streaming is not evidence of token-level audio streaming.
- Default interruption detection uses browser audio amplitude and can mistake
  noise/echo for speech. Test with laptop speakers as well as headphones.
- Do not use `ExternalMessageGateway`: it has a different trusted-service
  authority model, completed-response callbacks, and a documented revocation gap.

## Source ownership and implementation boundaries

Implementation belongs in an isolated worktree of `knitli/knitli-os`, not direct
edits to the pinned `apps/os/cloudflare-os` submodule. Expected areas are Workshop
frontend chat UI, the minimal authenticated voice-session API and voice DO,
shared protocol types, and the DO migration/route configuration. Reuse Kumo and
the Workshop's existing UI conventions.

Update the deployment wrapper's submodule pin only after the implementation is
accepted. Its deployment generator already provides `WORKERS_AI`; verify the
new voice export, migration, and route survive generated production config.
Use `/api/...` routing or explicitly account for static-asset routing precedence.

Inspected source: pinned OS `b782a36439dd6887877352912596114c950b01a2`;
independent checkout `2336c474546f810e5abf2a9b0d09a64fdef7b7fa`. Recheck the
current branch and base before implementation; the independent checkout contains
unrelated work.

Key pointers under the pinned OS:

- `packages/workshop-shared/src/api.ts`: `sendChatMessage`, `subscribeToChat`,
  `stopAgent`, `AiChatSubscriber.textDelta`, `streamGeneration`.
- `packages/workshop-backend/src/overseer.ts`: `assertChatNotActive`,
  chat submission, collaborator authorization, subscription revocation lease.
- `packages/workshop-backend/src/server.ts`: authenticated API and `/api` routing.
- `packages/workshop-frontend/src/ChatInterface.tsx`: chat submission and stop UI.
- Installed `agents/dist/voice/index.js`, `voice/client.js`, and
  `voice/workers-ai.js`: actual pinned voice contracts.

## Acceptance checks

1. A spoken turn reaches the same chat exactly once, uses its selected model,
   and produces audible assistant output plus the normal chat record.
2. Barge-in immediately stops playback; an agent task demonstrably continues.
   Explicit Stop work still cancels through the native path.
3. Busy speech remains visible and editable; it submits once after idle.
   Disconnect/switch/end-call must not send it silently or duplicate a submission.
4. Wrong-session/expired credentials and outside-call text cannot bypass voice
   authorization or initiate model usage. Chat revocation still blocks submission.
5. Tool/reasoning events are never spoken; stale turn output and reconnects do
   not replay old speech. Voice history does not become a second chat database.
6. Microphone denial, unavailable providers, call end, and network loss release
   resources and leave text chat usable.
7. Real-browser test with headphones and speakers covers echo, pauses, barge-in,
   long-running work, and first-audio latency. Type/build/tests alone cannot establish
   conversational quality. Prove each new regression test fails for its named defect.
8. Dictation only edits the composer, including while busy, and makes no chat or
   TTS call. Switching modes preserves drafts without sending them; old-mode
   events cannot affect the new session. Manual Send keeps existing behavior,
   with the transcription note appended for dictated input.
9. Both modes append the transcription note exactly once to the model-facing
   submission. Edited/mixed and queued dictated drafts retain it; purely typed
   drafts do not receive it. The note is absent from the composer and TTS output.

The pinned SDK remains agents@0.24.0. Automated checks cover authenticated
same-chat transport and the SDK STT/TTS lifecycle with injected providers. A live
microphone/hosted-model check is still required before deployment.

## First-version limits

- Conversation starts in an existing chat with an agent model selected. Dictation
  can prepare the first message without starting agent work.
- Speech uses committed assistant messages, not provisional token deltas. This
  avoids replaying revised model text; measure first-audio latency in the live trial
  before extending the bridge to provisional output.
- An audio session ends after one hour and must be started again. Response text is
  bounded to 65,536 characters per spoken turn; the complete answer stays in chat.
- No production deployment or wrapper submodule update has been performed.



## Display correction accepted 2026-09-29

The user wants no live transcript text in Conversation mode and no separate
transcript box beside either voice control. Dictation writes only into the main
composer. Keep recognized conversation text in internal state for submission;
normal committed chat messages remain in history. Pending/failed speech must not
be discarded: expose it for review in the main composer after End or an error,
not as a secondary streaming input. Keep status accessible without taking up the
composer toolbar; actionable errors remain visible. No invisible DOM transcript
container is needed for the SDK.
