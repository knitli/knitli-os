# Prompt presets + reasoning controls: implementation plan

*Repo: knitli-os (`/opt/coder/knitli-os`). All paths below are relative to it. Line
numbers are fork-HEAD-verified anchors; re-locate at implementation if the tree moved.
Companion feasibility discussion: 2026-09-14 (swap,
globals-first, agent blindfold, per-turn effort decisions — recorded in Key Decisions).
This plan is Phase 1 (slices 0–2) plus a designed Phase 2 (slice 3); implement in slice
order, one PR per slice.*

## Goal

Fix the three model-experience gaps in the Workshop: (1) the gadget-assuming system
prompt confuses workspace models asked to do anything else; (2) there is no prompt
selection UI; (3) there are no model-setting controls, which the parameter-sensitive
Workers AI models (GLM, DeepSeek, Kimi) need. Keep the existing prompt as the default
`gadget builder` preset; add swappable global presets, per-chat prompt selection, and
per-turn reasoning-effort control.

## Success Criteria

- A chat can run under a non-gadget system prompt chosen in the composer; the default
  for existing and new chats is byte-identical to today's prompt.
- A user can set reasoning effort per turn from the chat UI for any picker model, across
  the model's full level range (including `max`/`xhigh` where the model supports it);
  Workers AI models actually receive the mapped provider value.
- An admin can define deployment-wide prompt presets without redeploying or editing code.
- Changing a chat's prompt shows a cache-discontinuity warning; changing effort does not.
- `fork:audit` stays clean on every slice; no Tier-2 hunk reflows unrelated lines.

## Context And Current Facts

- **Single system prompt.** `packages/workshop-backend/src/agent.ts:667` (`SYSTEM_PROMPT`,
  ~200 lines; spawner variant at :880) consumed at exactly two sites in `runAgent`.
  `instanceInstructions` (admin text, `admin-config.ts:30`) is appended to the static
  slot, which is kept byte-stable for Anthropic prompt caching (`agent.ts:2345-2352`).
- **No reasoning UI or plumbing exists.** `reasoningEffort`/`thinkingLevelMap` appear
  only in `ai-models.ts`. `makeHandle` hardcodes `reasoningEffort: "medium"` solely for
  `openai-responses` (:300); Workers AI models (`openai-completions`) get the provider
  default. Both cloudflare branches (`gatewayNativeModel` ~:234, `getModelDirect` ~:540)
  drop `thinkingLevelMap` while the other providers forward it — latent bug.
- **The pipe already works.** pi-ai 0.84.4 maps `options.reasoningEffort` through
  `model.thinkingLevelMap` (installed `dist/api/openai-completions.js`); pi-agent-core
  0.84.3 spreads the loop config into stream options (`dist/agent-loop.js`
  `streamAssistantResponse`); `makeHandle.stream` merges explicit per-call options over
  its defaults (`ai-models.ts:305-345`). So `runAgentLoopContinue(config)` at
  `agent.ts:3476` forwards `reasoningEffort` end to end today — nothing passes one.
- **The /providers "catalog" is static and carries no reasoning data.** The page renders
  `listModels()` (`providers.tsx:150-151`): gateway built-ins from
  `AiGatewayConfig.getModelList()` (`ai-gateway.ts:87-97` — `SUGGESTED_MODELS` filtered
  by enabled providers, merged in `user.ts:528-548`) plus stored custom models. Entries
  are `{type, id, name}` profiles only, and `AiGatewayInfo` carries just
  `enabled`/`enabledProviders`. No gateway model-metadata endpoint is fetched at
  runtime (searched backend + `ai-gateway-billing`: no `/models` call; the `WORKERS_AI`
  binding is a fetch transport). Per-model level ranges must therefore come from
  pi-ai's maps (`dist/providers/data/*.json`, 0.84.4 — uneven: DeepSeek V4 `high/max`;
  GPT-5.6 full range incl. `xhigh/max`; GLM-5.2/Kimi low/med/high; GLM-5.3-Flash and
  Haiku 4.5 no map; Gemini 3.6 Flash empty; vocabulary `minimal/low/medium/high/xhigh/
  max`, no `ultra`) merged with fork overrides.
- **Precedents to mirror.** `ComposerModelSelector.tsx` (composer dropdown),
  `setChatTitle(chatId, title)` (`api.ts:2237`, per-chat metadata write path),
  `instanceInstructions` (admin text → per-turn read via `AgentHooks`,
  `agent.ts:597`), blueprints (user-authored shareables + library-by-reference +
  deployment-featured tiers — `listOwnBlueprints` / `listLibraryBlueprints` /
  `listFeaturedBlueprints` in `api.ts`), chat gadget pins.
- **Fork discipline is mechanized.** `scripts/fork/fork-boundary.json` declares Tier-1
  (fork-owned, zero-conflict) prefixes — notably `packages/workshop-backend/src/fork/`
  ("policy lives here behind a one-line upstream seam"). `pnpm run fork:audit` check 2
  (no reflow in upstream files) runs on every branch. Tier-2 = hand-resolved.
- **Test/verify commands** (fork `package.json`s): backend
  `pnpm --dir packages/workshop-backend run test:run` (unit + integration vitest),
  frontend `pnpm --dir packages/workshop-frontend run test:run` (vitest/jsdom),
  `pnpm run build` (is `types:check`), `pnpm run lint:check`, `pnpm run fork:audit`.

## Constraints And Non-goals

- Work lands in knitli-os; knitli-site consumes it via a submodule pin bump (slice 4,
  separate change — `.gitmodules` uses `ignore = dirty`, and the pin has been silently
  reverted before, so the bump must verify the gitlink change explicitly).
- Tier-2 edits stay minimal and reflow-free (audit check 2). New fork policy goes under
  Tier-1 prefixes; new Tier-1 prefixes get `fork-boundary.json` entries (audit check 3
  verifies upstream has no file there).
- Non-goals for this plan: spawner-prompt presets; admin per-model default UI
  (deferred — see Key Decisions); catalog entries for unreleased models (GLM-5.3,
  DeepSeek 4.1 — a trivial `SUGGESTED_MODELS` edit plus pi bump when they land);
  preset composition/inheritance; effort plumbing in `workshop-evals`.

## Key Decisions

1. **Swap, not append; `gadget builder` stays the default.** The selected preset
   replaces the slot-0 base text; unset/scoped-out chats get today's constant
   byte-identical. Rejected: rewriting the prompt in place (~200-line Tier-2 diff on a
   high-churn foundation file) and append-only (doesn't fix the gadget confusion).
   `instanceInstructions` keeps appending after the preset; `SPAWNER_SYSTEM_PROMPT`
   unchanged in Phase 1.
2. **Globals first (AdminConfig), customs second (prompt gadgets).** Deployment presets
   reuse the admin-settings RPC + `AdminPage` pattern. Workspace-attached prompt files
   (`PROMPT.md` convention, blueprint-publishable, pinnable) follow in slice 3.
3. **Per-chat effort override wins at turn start; per-turn; no warning.** Selection
   writes chat metadata immediately (persists across reloads/clients, mirrors
   `setChatTitle`); the turn reads it. Effort is a request parameter, not prefix
   content, so it doesn't invalidate the Anthropic prefix cache — no warning. Prompt
   swaps change slot 0 and do bust cache — warn.
4. **Reasoning data: app catalog ids resolved through pi maps + Tier-1 overrides.**
   The catalog is the one /providers shows (`SUGGESTED_MODELS` + stored customs); it
   carries no level data, so a fork-owned resolver (`src/fork/reasoning-levels.ts`)
   attaches ranges per model id, using pi's `thinkingLevelMap` as one input and fork
   corrections for the gaps (starting with the missing GLM-5.3-Flash map). Single
   wiring site in `makeHandle`; UI reads levels via a new `getModelReasoning` RPC
   (pi-ai stays out of the frontend bundle). If a gateway-side metadata source ever
   appears, only the resolver changes.
5. **Defer stored-model admin defaults.** The need (tunable sensitive models) is met by
   fork-table defaults + the per-chat control; a third precedence layer now buys
   complexity, not capability. `AiModelConfig.reasoningDefault` remains available later
   as an optional, migration-free field.

## Recommended Approach

Three shippable Phase-1 slices, each independently reviewable and behavior-safe, then
the Phase-2 prompt-gadget slice, then rollout. Slice 0 changes no behavior (it only
makes correct data flow); slice 1 adds the effort path; slice 2 adds presets + swap.
All fork policy lives in `src/fork/` (backend, Tier-1 already) and one new Tier-1
frontend prefix; Tier-2 surface is enumerated per slice and stays at seam scale.

## Work Plan

### Slice 0 — Reasoning data foundation (backend, no UI, zero behavior change)

- NEW `packages/workshop-backend/src/fork/reasoning-levels.ts` (Tier-1, no boundary
  change needed): `resolveThinkingLevelMap(piProvider, modelId, catalogMap)` returning
  the merged map, plus `defaultReasoningEffort(...)`. Initial overrides: GLM-5.3-Flash
  levels (from Workers AI docs at implementation time); everything else passes pi's map
  through; unknown models get a conservative default. Colocated
  `reasoning-levels.test.ts` (Tier-1 by prefix).
- `ai-models.ts` [Tier-2, one hunk]: in `makeHandle`, resolve and attach the merged
  `thinkingLevelMap` onto the constructed model. This simultaneously fixes the two
  cloudflare branches that drop it. No `reasoningEffort` passed yet → no behavior
  change; mapping/clamping now correct whenever effort flows (slice 1).
- `api.ts` [Tier-2, additive]: `AuthenticatedApi.getModelReasoning(modelId: string):
  Promise<{levels: string[], default: string} | null>`, resolving exactly the model ids
  /providers lists (gateway built-ins via `resolveModel` + stored-config lookup) through
  the slice-0 resolver. Returns null for unknown ids.
- Tests: unit tests for merge precedence (override wins, catalog passthrough, unknown
  model); RPC test resolving a gateway built-in and a stored custom model. Prove each
  new test fails (sabotage: drop the merge call, point at the raw catalog).

### Slice 1 — Per-chat effort override, end to end

- `api.ts` [Tier-2, additive]: `AiChatMetadata.reasoningEffort?: string` (:2486 area);
  `setChatEffort(chatId, effort | null): Promise<void>` next to `setChatTitle` (:2237).
- `overseer.ts` [Tier-2]: metadata write path for `setChatEffort`; turn-start read
  (adjacent to `chosenModel`, :7152) threaded into the existing `runAgent` opts bag.
- `agent.ts` [Tier-2]: accept `reasoningEffort` in `runAgent` opts, pass into
  `runAgentLoopContinue` config (:3476) — pi-agent-core forwards it to `handle.stream`,
  whose merge already lets explicit values win. Add `reasoningEffort?` to
  `ModelStreamOptions` (additive field, mirrors `thinking?`).
- Frontend: NEW `ComposerEffortSelector.tsx` under NEW Tier-1 prefix
  `packages/workshop-frontend/src/features/chat/controls/` (+ `fork-boundary.json`
  entry; verify no upstream file there). Sibling props shape to
  `ComposerModelSelector`; options from `getModelReasoning` for the selected model;
  on change, calls `setChatEffort` immediately (this is the "UI selection at turn
  start wins" mechanism). Wire into `ChatComposer` [Tier-2]. No warning UI.
- Tests: backend RPC/meta round-trip + turn-start threading (assert the effort reaches
  the stream options via the existing request-capture seam — `makeHandle` honors a
  per-call `fetch`, which tests already use to capture); frontend component test for
  the selector (options render, change fires RPC). Sabotage-proof each.

### Slice 2 — Global presets + swap + warn-on-change

- `admin-config.ts` [Tier-2]: `promptPresets: {id, name, text}[]` (+ default `[]` and
  tolerant parse, mirroring `instanceInstructions`, :30/:86/:305). `admin-settings.ts`
  [Tier-2]: extend the admin view/update RPC pair. `AdminPage.tsx` [Tier-2]: presets
  section (list/add/edit/delete; the built-in `gadget builder` shown as the implicit
  default, not stored).
- `api.ts` [Tier-2, additive]: `AiChatMetadata.promptId?: string | null`;
  `setChatPrompt(chatId, promptId | null)` next to `setChatTitle`.
- `overseer.ts` [Tier-2]: write path + turn-start read into `runAgent` opts (same
  call site as slice 1).
- `agent.ts` [Tier-2, one hook]: in `runAgent` prompt-slot construction (:2345-2486),
  resolve the preset text (preset from admin config, fallback to `SYSTEM_PROMPT`
  constant) as the slot-0 base; `instanceInstructions` still appended; spawner path
  untouched. Static-slot-first ordering preserved for caching.
- Frontend: NEW `ComposerPromptSelector.tsx` (same Tier-1 prefix as slice 1, no new
  boundary entry); `ChatComposer` wiring [Tier-2]; on change mid-chat, a confirm
  dialog with cache-discontinuity copy ("switching prompts clears the model's cached
  context for this chat"), then `setChatPrompt`.
- Tests: resolution unit tests (unset → byte-identical legacy prompt — assert against
  the constant, not a copy; set → preset text; instructions still appended);
  admin RPC round-trip; selector + confirm-dialog component tests. Sabotage-proof each.

### Slice 3 (Phase 2) — Prompt gadgets + agent blindfold + pins

- Convention: `PROMPT.md` in a gadget marks it a prompt (constant in `src/fork/`,
  Tier-1). Document in the fork docs.
- `agent.ts` [Tier-2, four micro-hooks]: (1) filter prompt files from the `## Gadget`
  file listing (:2400-2426); (2–4) guard `readFile`/`writeFile`/`editFile`
  (:2594/:2646/:2705) post-`resolveWorkpieceRoot`, throwing the identical
  "File does not exist." error (covers worktrees via root resolution; path-based, so
  blueprint-instantiated copies are covered too). Filter prompt-blueprints from the
  agent's `listBlueprints` tool (:3075) so it never sees the titles.
- `createBlueprint` path [Tier-2]: propagate a prompt marker into blueprint metadata
  when the source gadget is prompt-marked, so the filter and copy-guard have
  something to key on.
- Chat meta `promptRef` [Tier-2]: `{kind: "admin" | "gadget" | "blueprint", id,
  version?}` with pin semantics (gadget commit / blueprint version); resolution at
  turn start via `readFileAtCommit` (:2896, local) or KV/R2 fetch for
  by-reference library entries.
- Explicit check item: verify `materializeChatChanges` (live user-edit push to a
  running agent) never delivers prompt-file content; exclude if it does.
- UI: prompt presets listed from prompt-marked library blueprints (filter on the
  existing library, no new library system) [Tier-2].
- Tests: blindfold regression per tool (read/write/edit fail indistinguishably;
  listing omits); copy-attack test (agent instantiates prompt blueprint → reads
  fail); pin-stability test (prompt edit doesn't move an old chat's prefix).

### Slice 4 — Rollout (knitli-site + deploy)

- Separate change in knitli-site: bump the `apps/os/cloudflare-os` gitlink to the
  merged fork commit; verify `git status` shows the gitlink change explicitly
  (`ignore = dirty` has hidden reverts before).
- Deploy to a preview environment (`pnpm run preview:deploy` from the fork root),
  smoke: new chat defaults to gadget builder; swap preset with warning; set effort
  per turn on GLM-5.3-Flash and DeepSeek V4 Pro; confirm gateway logs show the mapped
  values.
- Optional: run `pnpm run evals` before/after slice 2 (costs inference; manual call).

## Validation Plan

- Every slice: `pnpm run fork:audit` (check 2 catches reflow), `pnpm run build`
  (type-check), `pnpm run lint:check`; backend slices add
  `pnpm --dir packages/workshop-backend run test:run`; UI slices add
  `pnpm --dir packages/workshop-frontend run test:run`. Full-file runs (storage
  isolation is per-file under workerd); never narrow a failing run to green.
- Every new test is sabotage-proven red-then-green (drop the merge call, revert the
  guard, point resolution at the raw constant), reported per slice — "tests pass" is
  not evidence a test works.
- Manual E2E per UI slice via `pnpm run dev-server` + `pnpm run dev-client`: slice 1,
  change effort mid-chat on a DeepSeek model and confirm the run; slice 2, swap
  presets, confirm the warning and that unchanged chats are byte-identical in behavior.
- Highest-risk validation: slice 3's blindfold completeness (the agent copy attack)
  and slice 2's swap-behavior (the original confusion complaint — needs real
  conversational probing, not just unit tests).

## Risks / Rollback

- **Tier-2 sync friction** (`agent.ts`, `overseer.ts` are high-churn foundation files).
  Mitigated by seam-scale hunks + Tier-1 policy modules; `fork:audit` on every slice.
- **Prompt-swap cache cost.** Real per Anthropic prefix caching; surfaced in UI copy,
  not hidden. Rollback: per-chat `promptId` unset → legacy constant; admin presets
  deletable without code.
- **pi catalog drift** (new models, wrong maps). Contained by the override table;
  process: correct in `reasoning-levels.ts` immediately, pick up pi bumps normally.
- **Effort/provider mismatch.** A level valid in pi but rejected by Workers AI
  surfaces as a provider error mid-turn; the override table is the correction point,
  and effort stays user-adjustable per turn.
- **Rollback per slice:** slice 0 is behavior-neutral (safe to keep or revert);
  slices 1–2 are additive-RPC + optional-meta (old clients ignore new fields; unsets
  reproduce legacy behavior exactly).

## Open Questions

None. All product decisions were settled in the design discussion (swap with `gadget
builder` default; globals then prompt-gadgets; agent blindfold incl. copies; per-chat
per-turn effort, warn on prompt change only). Assumptions, all reversible: initial
fork table fills missing maps only (defaults stay provider-default until tuned);
admin preset text unbounded (admin-trusted); `SPAWNER_SYSTEM_PROMPT` out of scope for
Phase 1; provider-native level names stay behind pi's maps (no `ultra` in 0.84.4).
