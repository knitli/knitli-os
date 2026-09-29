# Cloudflare Agents voice implementation plan

Status: implemented on feat/workshop-voice, based on origin/main b782a364. Worktree: /opt/coder/knitli-os/.worktrees/voice. Automated checks pass; live microphone/hosted-model acceptance remains.

**Goal:** Add distinct dictation and conversational voice modes to the existing Workshop chat.

**Architecture:** Use installed Cloudflare Agents voice for STT/TTS, with the authenticated browser bridging to its existing Overseer capability. Preserve native chat execution, permissions, and approvals.

**Spec:** [Approved design and decisions](../specs/2026-09-28-cloudflare-agent-voice-design.md).

## Confirmed behavior

- Dictation fills the editable composer; only explicit Send submits it. No TTS.
- Conversation submits speech automatically and speaks assistant text.
- Speaking over a reply stops audio while agent work continues. Explicit Stop work cancels work.
- While busy, show an editable pending instruction; submit once on actual idle, only within the same connected session and chat. Never automatically retry an uncertain submission.
- Mode switches, call end, and disconnect preserve drafts but revoke automatic submission.
- Both modes append the transcription-context note from the spec exactly once at submission, including edited dictation and mixed typed/dictated drafts. Keep it out of the composer and speech; typed-only input gets no note.

## Implementation sequence

1. Establish a clean, isolated knitli-os worktree from the verified intended base. Do not build on the unrelated ambient-connection-request branch or edit the deployment wrapper's pinned submodule.
2. Add authenticated, mode-bound voice session creation and a narrow voice Durable Object using the pinned SDK. Reuse existing origin checks and connection-secret helpers. Tie inference to the authenticated session lifetime and reject expired/reused connection tickets before model usage.
3. Add the browser voice bridge and explicit Dictate/Conversation controls in Workshop chat. Reuse existing composer, submit, approval, and Stop paths. Track dictated-draft provenance for the appended note.
4. Correlate accepted submissions with their own assistant output; implement busy queuing, abort cleanup, and an ordered audio interruption barrier. Do not infer ownership from chat ID or matching text alone.
5. Verify with focused regressions, real authenticated RPC integration, and browser audio checks. Prove regressions fail for their named defects. Independently review kernel/API and UI changes before updating the deployment wrapper pin.

## Verified source findings to retain

- Backend uses agents@0.24.0. Its withVoice constructor installs an instance onMessage handler; validation must wrap that instance handler after super, rather than relying on a subclass prototype override.
- Dictation can use afterTranscribe to emit a transcript and return null, which exits before conversation history, onTurn, and TTS. Reject conversation response messages in dictation sessions.
- Override public saveMessage and getConversationHistory to suppress parallel SDK history. A zero history limit does not suppress writes.
- Abort must settle a pending response iterator read, not merely mark its signal aborted.
- Stock playback accepts untagged binary frames after interruption. Gate audio until an ordered interruption acknowledgment and a newer accepted response start. Use arraybuffer WebSocket messages to avoid asynchronous Blob conversion reordering.
- Subscribe before submitting; reconcile provisional deltas against durable agent messages without repeating spoken text. A whole execution can span multiple assistant/tool rounds: actual idle metadata closes it.
- sendChatMessage currently returns void, and stream events identify the chat but not the submitting turn. Before coding the bridge, determine the smallest committed submission receipt/correlation change that safely distinguishes collaborator activity and handles events arriving before the RPC result.
- Do not use ExternalMessageGateway; its trusted-service authority and completed-response contract do not fit this browser session.

## Resolved implementation contracts

- sendChatMessage returns its committed prompt sequence (number | undefined; commands without a prompt return undefined). Existing callers may ignore it. The voice bridge buffers subscribed events until the receipt resolves, begins at that exact user message, and ends at idle or loss of ownership. newChat retains its existing new-chat ID return.
- createVoiceSession(mode) returns a short-lived one-use connection URL and an RPC session capability retained for the call lifetime. The server applies existing origin/Access rules and revokes on authenticated-session loss.
- The voice server emits voice_transcript with sessionId, turnId, text, and mode. Conversation accepts ordered voice_response frames with consecutive sequence, bounded text, and done; dictation accepts no response frames. Interruption acknowledgment separates old binary audio from a newer turn.
- Release/deployment generators already carry the voice migration and WORKERS_AI binding. Update the release golden manifest; local development needs --use-workers-ai-binding and the existing backend host convention.

## Ownership and checks

- Receipt agent: shared sendChatMessage signature, overseer commit return, integration helper typing, focused committed-sequence regression.
- Backend agent: voice session/DO, authenticated API and route, migration, runtime types, security/lifecycle and SDK checks.
- Frontend agent: explicit mode controls, composer provenance/note, conversational bridge, interruption/queue tests.
- Deployment agent: release golden manifest and its test.
- Root: integration, review, build/type checks, and accurate completion report.

Frontend baseline: 75 test files / 643 tests passed before feature edits. Existing jsdom scrollTo warnings do not fail the run. Dependencies installed from the frozen lockfile with pnpm 11.17.0 and Node 24.19.0. Backend browser-runtime and bundled-blueprint prerequisites generated.


## Working context at handoff

Source lives in this repository. The design was moved here from knitli-site at the user's request, with byte-for-byte verification. At handoff the checkout was on fix/ambient-connection-request at 2336c474 with unrelated .claude/settings.local.json changes; preserve them. Recheck branch/base and toolchain before implementation. This repo uses its own pnpm setup; do not import the wrapper's toolchain or root site's TypeScript constraints.

## Validation and continuation

- Full `pnpm lint` passed from the OS-owned worktree: lint, script types, workspace types/build.
- Backend full suites: 1,128 unit tests and 31 integration tests passed; four pre-existing skipped integration tests remain unchanged.
- Frontend full suite: 662 tests passed across 79 files, including the persisted draft provenance lifecycle.
- Release manifest suite: 12 passed; v4 VoiceSession migration retained by release and wrapper generators.
- Regression sensitivity verified by narrow, restored mutations: missing receipt, origin bypass, credential/expiry checks, outside-call input, abort settlement, response ordering, dictation entering TTS, duplicate SDK history, queue/session failures, missing native idle/receipt boundaries, and late binary playback. Each named check failed for its defect and passed after restoration.
- Backend SDK checks use injected transcription/synthesis providers; they do not establish hosted-model latency, recognition quality, echo behavior, or microphone compatibility.

The first worktree location under knitli-site leaked the parent site's lint rules.
Moving it into knitli-os/.worktrees/voice restored OS configuration isolation; no
product rules were weakened. Node 24.19.0 / pnpm 11.17.0 were used for checks.

### Live trial

With authenticated Wrangler and the repository's pnpm toolchain, run
`pnpm dev-server --use-workers-ai-binding` and `pnpm dev-client`, then open
localhost:3000. Voice uses the same-origin /api/voice WebSocket proxy. Select an
agent model in an existing chat to start Conversation; Dictate only fills the
composer. Test headphones and speakers, pauses, speaking over an answer, busy
queued edits, ending/restarting, and microphone denial. Confirm explicit Stop
work still cancels work, while ending/interruption only stops audio. Measure
first-audio latency before deciding whether provisional token forwarding is needed.

Do not update the deployment wrapper pin or deploy until this live acceptance is
complete. The plan and spec now belong to knitli-os, not the deployment wrapper.

Local implementation commits: `1074f717` (backend/API) and `5712b2f6` (frontend). Both are signed with the configured Git signing identity. Published in PR #42 (https://github.com/knitli/knitli-os/pull/42); no deployment was performed.


### PR review follow-up (2026-09-29)

The first Codex review identified failed-transcript retention, stale callbacks,
response relaying into replacement sessions, abandoned capability disposal, and
browser/server clock skew. The follow-up fixes these and preserves draft edits
and appended speech across successful or failed in-flight submissions. Uncertain
submissions remain explicit-only.

Validation: 21 focused voice tests and all 675 frontend tests passed; frontend
types and full `pnpm lint`/build passed. New tests failed against the original
behaviors; additional concurrent-send tests caught lost and duplicated text before
the fixes. Independent review found no remaining blocker in the follow-up patch.

Initial-head CI and Codex security review passed. Codacy and Codacy-production
have no checks on this or recent PRs; the authenticated Codacy repository lookup
returns not found. Their analysis is unavailable, not a passing result. Continue
monitoring CI and Codex after each push until the current head is clear.

Second review follow-up: end conversations when no agent is selected (including
pending session starts), clean up microphone-start failures, retain pending drafts
per chat and across replacement calls, preserve newline editing, and carry speech
provenance through slash-command expansion. Blank command results still reach the
existing empty-message rejection; built-in compact does not send its arguments to
a model. Validation: 683 frontend tests, seven focused slash-command tests, full
lint/build and backend/shared/frontend types passed. New regressions failed before
the fixes; independent hook review passed. Live microphone acceptance remains open.

Third review follow-up: preserve raw text in stored/displayed chat messages and
persist optional speech provenance; append the ambiguity note during actual agent
input reconstruction. Confirmed receipts now clear the owning chat's submitted
queue after navigation; empty edits remove queue records; async errors announce
via an alert. Validation: 686 frontend tests, 1,131 backend unit tests, and 31
backend integration tests passed (four existing skips); full lint/build passed.
Removing persisted provenance caused the real receipt regression to fail; removing
context application caused the conversion helper test to fail; both passed after
restoration. Full agent-pass wiring was source-reviewed, not exercised by that
helper test. Independent reviews found no remaining blockers in these changes.

Fourth review follow-up: session callbacks reject events for a different owning
chat before passive cleanup; finalized dictation segments use an acknowledged
queue so batching cannot replace earlier speech; failed queue reconciliation uses
untrimmed text; every release clears interim speech. Regression tests reproduced
all four defects and passed after fixes, including cross-chat queued dictation.
Validation: 693 frontend tests and full lint/build passed. Backend unchanged from
the third follow-up. Independent hook review found no new blocker.

Fifth review follow-up: unredeemed sessions expire with their tickets and start
heartbeat/call lifetime only after acceptance; generated RPC validation remains
authoritative. Voice submissions and pending Send honor connection/decision
blockers. Speech provenance now tracks surviving spans, persists validated ranges,
and maps exact composer edits and individual restored decorations. Fully typed
replacements drop the speech note; partial surviving dictation retains it.
Validation: 706 frontend tests, 1,135 backend unit tests, 32 backend integration
tests (four existing skips), and full lint/build passed. New tests failed for the
named defects before repair, including two-logo restoration and token edits.
Independent reviews found the reported blockers resolved. No deployment performed.

Sixth review follow-up: pending conversation edits reuse the composer speech-range
logic, so fully typed replacements omit transcription context while surviving or
newly appended speech retains it. The pending editor retains native keyboard focus
indication. A failed independent transcript is not confused with matching text in
an unrelated pending draft. Validation: 711 frontend tests, full lint/build, and
focused red/green provenance and queue-ownership proofs passed.

The reported new-chat dictation race is not applicable to current UI: the only
VoiceControls are inside the selectedChatId !== null render branch; the sidebar
new-chat composer has neither voice controls nor dictation append input. No
speculative new-chat voice feature was added. Backend unchanged this round.


## Post-deployment repair — 2026-09-29

User reported both modes briefly listening and returning idle without output after
microphone permission. They also requested controls on the initial composer, a
conversation icon, and dictation that stays active until explicitly stopped.
Work continues on `fix/voice-session-start`, based on merged main `5a7043d1`.

Root cause: the actual Agents 0.24 VoiceClient emits `connectionchange` inside its
socket-open handler, then checks whether it should recover an existing call.
Starting a call synchronously in our listener sets the SDK's in-call flag before
that recovery check, sending two `start_call` frames. Our single-call server
correctly rejects the second and revokes the connection. Defer our startup until
the open handler completes; retain ownership checks before the deferred call.
Unexpected disconnects should leave a visible error.

Reuse the existing continuous transcription path: finalized segments append to
the composer without ending dictation. Home conversation creates an empty chat
before starting capture, so the first spoken prompt and reply use the ordinary
chat subscription/receipt path. Preserve speech provenance for Home and new-chat
composer submissions. The initial launch must be one-shot, never a reload or
back-navigation microphone restart.

Remaining hosted-provider acceptance: stopping during an unfinished utterance
may discard words not yet finalized by Flux. The pinned SDK exposes no graceful
flush operation; do not claim final-utterance draining is verified. Test multiple
utterances, pause/resume speech, explicit Stop, and the last phrase at Stop during
the next live microphone trial.

Home handoff details: router history carries the new chat and chosen model once,
then removes the intent from history. Navigation away invalidates pending launch.
The chat waits for its subscription, chat list, and exact available model before
starting. Its initial model survives intent consumption and the first user-message
broadcast until authoritative agent state arrives; manual model changes cancel
the pending launch. Independent review found and resolved both lifecycle gaps and
the empty-chat model reset.

Repair validation: all 720 frontend tests (82 files), 11 voice backend tests, and
full lint/types/build passed. The real VoiceClient test observed two start frames
before the fix and exactly one afterward; it also covers multiple dictated
segments and explicit stop. Removing disconnect feedback failed its regression.
Ten narrow UI mutations failed the relevant assertions (speech provenance, empty
chat creation, error feedback, launch cancellation, history consumption, handoff
invalidation, Stop label, initial model, first-user gap, and exact-model startup),
then all affected files passed after restoration. No hosted microphone trial or
deployment was performed for this repair.

PR #43 review follow-up: cache the in-flight/successful Home voice-chat creation
on its provisional workspace. Metadata/navigation retries now reuse that chat,
including when metadata fails before creation settles. Replacing the workspace
would abandon draft resource references and would not delete its persisted record.
A rejected creation clears only the cached promise. Three partial-failure tests
failed with duplicate creation before the fix; removing rejection reset failed
retry recovery independently. Restoration passed all eight Home tests, all 723
frontend tests, and full lint/types/build. Backend code is unchanged.

Further Home review follow-up: block Conversation while a draft/resource, resource
picker, file preparation/upload, or send is active. Dictation remains available.
A live composer eligibility getter is checked both before launch and after RPCs;
this prevents navigation from discarding resources staged during a slow launch.
Model changes invalidate pending launch. A regular Home submission also cancels
launch and sends into the cached voice chat with its full resource/format/speech
payload, rather than creating another empty thread.

Integrated validation: all 731 frontend tests (82 files) and full lint/types/build
passed. Five Home regressions failed before their cancellation/reuse/live-draft
fixes. Removing composer/control guards caused four named failures, and forcing
the authoritative attachment accessor false independently failed its before-render
assertion; all passed after restoration. Scoped independent review found no
remaining blocker. Backend production source is unchanged.
