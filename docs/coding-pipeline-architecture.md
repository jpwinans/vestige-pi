# Coding Pipeline — Architecture

How the local multi-model coding pipeline is built as an extension of pi in this repo. This
document is the implementation-level companion to the design in `coding-pipeline.md` and the
ordered work-streams in `../todo/`. It records the architecture, the resolved decisions, and the
exact pi primitives each part composes.

## 1. One-paragraph shape

A single private workspace package, `packages/build`, an **external consumer of pi's public
APIs**, runs one Node process containing a plain, exhaustively-typed TypeScript **finite state
machine** that is the sole supervisor. The three "thinking" roles (planner = Opus, reviewer =
Gemma, arbiter = Opus) are **single-shot `completeSimple` calls** with forced-tool structured
output. The one "acting" role (implementer = Qwen) is **one `pi-agent-core` `Agent` loop**
confined by a `beforeToolCall` worktree jail. Gate A, the red-check, the live-smoke, and every
git/worktree operation run as **deterministic orchestrator `execCommand` calls** whose verdicts
are process exit codes — never model claims. Roughly 90% of the runtime weight (HTTP, provider
stack, tool loop, auth, file/bash tools) is reused pi machinery; the net-new code (~700–900 lines)
only sequences and validates.

The control flow is discipline-as-code: an LLM never decides what happens next. Models are called
at role-points only; the loop, the gates, the caps, and the escalation ladder are TypeScript.

## 2. Role casting and endpoints

| Role | Model | Reached via | API layer |
|------|-------|-------------|-----------|
| Planner / arbiter | Opus (`claude-opus-4-8`) | Anthropic cloud (no local port) | `completeSimple`, forced tool |
| Implementer | Qwen3-Coder-Next | `http://localhost:8081/v1` | `pi-agent-core` `Agent` loop |
| Reviewer | gemma-4-26B-A4B-it | `http://localhost:8080/v1` | `completeSimple`, forced tool |

The two local models are plain `Model<'openai-completions'>` literals. Opus is resolved from the
built-in registry.

### Phase 1 (local-only): no Anthropic

Phase 1 ships the pipeline **without the cloud leg** — the two local models only. Opus has exactly
two call-sites, both with clean fallbacks, so nothing structural changes:

- **Stage 0 planner** → replaced by a **human-authored plan artifact**. The plan (spec + rubric +
  failing tests) is authored offline via the `build-plan` Claude skill and passed to `/build` as a
  directory path. Stage 0 becomes `loadPlan(dir)` → validate → red-check, not an Opus call.
- **Stage 8 arbiter** → the escalation ladder **collapses to the human gate**: on any cap or
  deadlock, `/build` surfaces the decision directly to the operator (a `ctx.ui.select` dialog in
  the TUI, or the `acceptance_required` halt when headless). The arbiter rung is simply absent.

Everything between Stage 0 and the DoD is byte-identical to the full design — Qwen implements,
Gate A runs via `execCommand`, Gemma reviews, the revise loop, the live-smoke, the decision log,
the safety gate. Phase 1 properties:

- **No cloud, no cost, no OAuth.** The D7 OAuth decision and its forced-`system[0]` constraint are
  deferred entirely to Phase 2; `models.ts` health-checks only the two local servers.
- **It isolates the #1 risk early.** Whether the *local* Gemma reliably emits the forced-tool
  structured review is the biggest unknown; Phase 1 puts exactly that — plus the worktree jail, the
  gates, the Qwen loop, and the structured-output path — under test with nothing cloud in the way.

Phase 2 adds the Anthropic leg back: Stage 0 can take a free-text task that the Opus planner
expands into the plan, and the arbiter rung returns above the human gate.

### Plan input contract

`/build <plan-dir>` consumes a plan directory: `plan.json` (manifest — `commands.{test,lint,
typecheck,smoke}`, `testPaths`, `liveSmokeSurface`), `spec.md`, `rubric.md`, and `tests/` with
each test file mirrored at its real repo-relative path under `tests/`. The loader maps this to the
internal plan object (`spec` from `spec.md`, `rubric` from the `rubric.md` checklist, `tests` from
walking `tests/**`, `commands` from `plan.json`); Stage 0 writes the tests into the worktree and
runs the red-check (`commands.test` must exit non-zero) before implementation. The `build-plan`
skill authors this directory and proves the red state before handoff.

## 3. Resolved architecture decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | API layer per role | `completeSimple` (forced-tool, single-shot) for planner/reviewer/arbiter; one raw `pi-agent-core` `Agent` loop for the implementer. **Reject** `createAgentSession` and subprocess for all roles. | Three roles return exactly one validated object — `completeSimple` is the leanest surface (context in, one `AssistantMessage` out, parsed in TS, no hidden loop/persistence/retries). Only the implementer needs a multi-turn read/edit/write/bash loop; the `Agent`'s four hooks (`beforeToolCall` = gate seam, `shouldStopAfterTurn` = turn cap, `getApiKey` = local dummy key, `onResponse` = cost capture) are the exact deterministic seams without `createAgentSession`'s baggage. `createAgentSession` persists sessions and mutates `settings.json` on `setModel`, and assembles an uncontrolled skills/AGENTS.md system prompt. Subprocess (the only repo "subagent" precedent shells out a child `pi --mode json`) forfeits in-process faux-testability and typed cost telemetry. |
| D2 | Placement | Standalone private package `packages/build` (`"private": true`), external consumer of pi's public exports; vendor the ~90 unexported internal lines into `src/vendor/`. | A new `packages/*` dir joins the existing `workspaces` array automatically. `execCommand`, `resolvePath`, `getCwdRelativePath`, `canonicalizePath` are **not** in `packages/coding-agent/src/index.ts`, so vendoring is forced; living inside coding-agent would couple to its internal module layout. `"private": true` keeps it out of the npm publish/lockstep-publish path. (`packages/mom` is **not** a precedent — biome only ignores `packages/mom/data/**` inside an existing package.) |
| D3 | Gate A execution | Orchestrator-driven vendored `execCommand` (array args, `shell:false`, `{signal,timeout}`) against the worktree; never a model bash tool. | Keeps test/lint/type output out of the model token budget; the pass/fail verdict is a deterministic integer in TS, not model self-grading. Gate A is a separate phase the implementer Agent has no access to — the real guarantee. The same runner powers the Stage-0 red-check and the live-smoke. |
| D4 | Worktree isolation | Disposable git worktree + **canonicalizing** path gate as the portable default (`config.sandbox='none'`); OS sandbox (`@anthropic-ai/sandbox-runtime`, darwin/linux) as an explicit opt-in ring (`config.sandbox='os'`). | The disposable worktree makes best-effort bash escapes harmless, so the default needs no extra runtime dep. **Critical fix both security judges flagged:** `resolvePath`/`getCwdRelativePath` are lexical-only (node `path.resolve`, no `realpath`), so an in-worktree symlink to an external target escapes the jail. The jail must apply `canonicalizePath` (which uses `realpathSync`) to both the resolved path and the worktree root before the containment check. |
| D5 | Structured output | Forced tool call + TypeBox validate + reprompt (cap 2) + text-JSON fallback, centralized in one `callRole` helper that branches on `model.api`. | pi-ai has **no** `response_format`/`json_schema`/`json_object`/grammar. The only mechanism is `Context.tools` + `options.toolChoice`. The two dialects differ: `{type:'function',function:{name}}` (openai-completions) vs `{type:'tool',name}` (anthropic). Success is `stopReason === 'toolUse'` (not `'stop'`); `toolCall.arguments` is already JSON-parsed. Local tool-calling unreliability is the #1 risk → fallback re-issues without `toolChoice`, prompts for raw JSON, parses the first balanced object, re-validates; double failure → typed error → escalate. |
| D6 | Decision log | Bare versioned JSONL (header line + one validated discriminated-union event per line via `appendFile`), which also serves as the crash-resume/replay journal. | Mirrors `JsonlSessionStorage` (header + `isRecord`/field/version guard) without `Session`'s tree machinery or settings side-effects. Journaling the intended action before each side-effect gives crash-resume and replay for free; the flat log **is** the replay tape for the pure-function state machine. |
| D7 | Opus auth | **Claude Pro/Max OAuth** (`sk-ant-oat`) — chosen by the owner. | OAuth forces `system[0] = "You are Claude Code, Anthropic's official CLI for Claude."` + claude-code/oauth beta headers, so the pipeline **cannot own the system prompt**. Consequence: the planner/arbiter persona and instructions are authored in the **user turn**, not `system[0]` — role framing must not rely on the system prompt. Auth resolves transparently via `AuthStorage.create()` + `ModelRegistry` + `getApiKeyAndHeaders` (OAuth is auto-detected from the token string; no code branch needed). Omit `temperature` (Opus 4.8 rejects non-default). Per-token `usage.cost` is still computed from `model.cost`, but under a subscription it is a notional estimate, not a billed charge. |
| D8 | Vendor drift handling | Provenance header (upstream path + commit) on each vendored file + a unit test asserting jail behavior against concrete escape vectors. No heavyweight CI byte-diff. | A behavioral test catches the failure mode that matters (a jail regression) far more directly than a byte-diff over deliberately frozen lines. |

## 4. Package layout

```
packages/build/
  package.json            # private:true, type:module, lockstep version, exports map,
                          # scripts: clean=shx rm -rf dist, build=tsgo -p tsconfig.build.json, test=vitest --run
  tsconfig.build.json     # extends ../../tsconfig.base.json, outDir ./dist, rootDir ./src
  src/
    cli.ts                # `pipeline run <task>` and `--resume <run-id>`; imports '@earendil-works/pi-ai' first (provider registration)
    extension.ts          # coding-agent extension: registers the /build slash command (TUI + headless print mode); thin adapter over runPipeline()
    orchestrator.ts       # the Phase FSM, caps, escalation ladder, journal/replay/resume
    models.ts             # 3 Model objects + auth + health-check
    callRole.ts           # forced-tool structured-output primitive
    schemas.ts            # TypeBox schemas + erasable-safe Phase/DecisionEvent unions
    implementer.ts        # Qwen Agent loop
    safety-gate.ts        # canonicalizing worktree jail (beforeToolCall)
    gate-a.ts             # deterministic test/lint/type runner + red-check + smoke
    gate-b.ts             # Gemma review + anti-rubber-stamp post-check
    revise.ts             # fix/defend/defer + re-gate
    escalate.ts           # Opus arbitration + human gate
    worktree.ts           # disposable worktree lifecycle + stash checkpoints + stale-prune
    decision-log.ts       # JSONL writer + replayer + summary.md renderer
    vendor/
      exec.ts             # frozen copy of coding-agent core/exec.ts (execCommand) + provenance header
      paths.ts            # frozen copy of utils/paths.ts (resolvePath, getCwdRelativePath, normalizePath, canonicalizePath)
```

### Reused (zero authored lines, ~90% of runtime weight)
`completeSimple`/`streamSimple` + the entire provider stack; the `Agent` tool loop + all four
hooks; `createCodingTools`/`createReadOnlyTools`/`withFileMutationQueue`; `AuthStorage` +
`ModelRegistry` + `getApiKeyAndHeaders`; `getModel`; `registerFauxProvider`; TypeBox; optional
`SandboxManager.wrapWithSandbox`.

### Vendored (~90 lines, copied not authored, frozen with provenance)
`vendor/exec.ts` (`execCommand`) and `vendor/paths.ts` (`resolvePath`, `getCwdRelativePath`,
`normalizePath`, `canonicalizePath`). `canonicalizePath` is included specifically to close the
symlink gap.

### Net-new (authored, ~700–900 lines of orchestration glue + schemas)
orchestrator ~220 · models ~110 · callRole ~95 · schemas ~110 · implementer ~80 ·
safety-gate ~85 · gate-a ~120 · gate-b ~95 · revise ~90 · escalate ~70 · worktree ~85 ·
decision-log ~90 · cli ~50 · extension (TUI `/build` adapter) ~60. No primitive is reinvented —
every capability the platform lacks (subagents, `response_format`, path confinement, git-worktree
helper, uniform `callRole`) is composed from existing primitives or vendored.

### Invocation surfaces

The orchestrator core is invocation-agnostic: `runPipeline(task, config, hooks)`, where
`hooks = { signal?, onEvent?(e: DecisionEvent), resolveHumanGate?(summary) => Promise<HumanDecision> }`.
Three thin adapters share it:

| Surface | Adapter | Behavior |
|---------|---------|----------|
| `/build <plan-dir>` (TUI) | `extension.ts` (`pi.registerCommand`) | Runs `runPipeline` out-of-band of the active agent loop; streams `onEvent` into a `ctx.ui.custom()` progress component; abort via the component's cancel key (`ctx.signal`). |
| `pipeline run <plan-dir>` / `--resume` | `cli.ts` | Fully headless terminal run. |
| `pi -p "/build <plan-dir>"` | `extension.ts` in print mode | Same command, `ctx.hasUI === false`, no dialogs. |

The first argument is the build input: in Phase 1 a **plan directory** (authored by the `build-plan`
skill); in Phase 2 it may also be a free-text task that the Opus planner expands into the plan.

Key properties:

- **It is a command, not a prompt.** `/build` does not go through the TUI's current
  AgentSession/agent loop — the command handler runs the separate 3-model supervisor directly
  (the established `handoff.ts`/`summarize.ts` out-of-band-model-call pattern). The user is
  triggering the pipeline, not chatting with one model.
- **Human-gate unifies via `ctx.hasUI`.** The escalation `needs_human` ruling resolves through
  `hooks.resolveHumanGate`: in the TUI adapter that is a `ctx.ui.select`/`ctx.ui.confirm` dialog;
  in CLI/print adapters it writes the `acceptance_required` artifact and halts. Same core.
- **Long-run UX.** A command handler blocks the editor while it runs, and a pipeline run is
  minutes-long, so the TUI adapter renders a foreground "watch it run" progress component
  (live phase/gate state + cancel) rather than fire-and-forget — true background is not the
  idiomatic command model (handlers are awaited; `ctx` goes stale after session changes).
- `extension.ts` is the **only** coding-agent-coupled file; `cli.ts`, the core, and the headless
  path stay independent of the extension runtime.

## 5. Control flow (the state machine)

A single explicit FSM in `orchestrator.ts`. Erasable-TS compliant — string-literal unions and
discriminated unions only (no `enum`), exactly like `StopReason`/`AssistantMessageEvent`.

```ts
type Phase = 'plan' | 'red_check' | 'implement' | 'gate_a' | 'gate_b'
           | 'revise' | 'escalate' | 'done' | 'failed';
```

`PipelineState` (mutable, in closure): `{ phase, runId, worktree, branch, plan?, findings[],
ruling?, gateAAttempts, gateBAttempts, reviseAttempts, checkpointRef?, signal }`.

Loop:

```ts
while (phase !== 'done' && phase !== 'failed') {
  journal({ type: 'phase_enter', phase, attempt });
  const next = await handlers[phase](state);   // exactly one role call or one execCommand
  journal(resultEvent);                          // inspect the TYPED result
  phase = next;                                  // pure switch on typed output
}
```

Caps are integer counters checked in TS **before** each role call: `gateAAttempts ≤ 4`,
`gateBAttempts ≤ 3`, `reviseAttempts ≤ 3`. A root `AbortController` threads through both Agent
calls and every `execCommand` so a hung local-model turn or test command cannot stall the cap
loop on wall-clock (caps bound attempts, not wall-time).

Transitions:

- `plan → red_check`
- `red_check`: tests collect **and** fail red (`execCommand`, assert non-zero) → `implement`;
  green/empty-tree → `escalate` (vacuous plan rejected)
- `implement → gate_a`
- `gate_a`: pass → `gate_b`; fail and `gateAAttempts < 4` → `implement` (repair with distilled
  failures, ++); fail at 4 → `escalate`
- `gate_b`: approve → `done` (runs the DoD live-smoke; smoke-fail → `revise` with the bug as a
  test); findings and `gateBAttempts < 3` → `revise`; at 3 → `escalate`
- `revise`: apply fix/defend/defer, then **always** re-run `gate_a` then `gate_b`
- `escalate`: Opus arbiter runs **exactly once** → `re_plan` loops to `plan` with the amendment /
  `side_*` resumes `revise` once / `needs_human` → human gate → `revise` or `failed`

DecisionEvent (the replay tape):

```ts
type DecisionEvent =
  | { type: 'phase_enter'; phase: Phase; attempt: number }
  | { type: 'plan'; spec: string; rubric: string[]; testCount: number }
  | { type: 'red_check'; passed: boolean; exitCode: number }
  | { type: 'implement'; attempt: number; costUsd: number }
  | { type: 'gate_a'; attempt: number; passed: boolean; results: GateAResult }
  | { type: 'gate_b'; attempt: number; verdict: string; findings: Finding[] }
  | { type: 'revise'; decisions: ReviseDecision[] }
  | { type: 'escalate'; ruling: Ruling; humanDecision?: string }
  | { type: 'checkpoint'; stashRef: string }
  | { type: 'done'; smokePassed: boolean }
  | { type: 'usage'; role: string; model: string; tokens: number; costUsd: number };
```

Resume: journal-before-side-effect means a restart reconstructs state from the last consistent
event; `git worktree prune` removes orphaned trees; the run resumes at the last completed phase
with a fresh worktree re-checked-out from `checkpointRef`. Phase-boundary resume only (no
mid-turn resume).

## 6. Provider wiring

Local models — plain literals, explicit `compat`, dummy key (the provider hard-throws on a falsy
key, and an arbitrary provider string gets no env-key fallback):

```ts
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const localCompat = {
  maxTokensField: 'max_tokens',
  supportsStore: false,
  supportsStrictMode: false,
  supportsReasoningEffort: false,
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
};
const qwen: Model<'openai-completions'> = {
  id: 'Qwen3-Coder-Next', name: 'Qwen3 Coder', api: 'openai-completions',
  provider: 'qwen-local', baseUrl: 'http://localhost:8081/v1',
  reasoning: false, input: ['text'], cost: zero, contextWindow: 262144, maxTokens: 16384,
  compat: localCompat,
};
const gemma: Model<'openai-completions'> = {
  ...qwen, id: 'gemma-4-26B-A4B-it', name: 'Gemma Reviewer',
  provider: 'gemma-local', baseUrl: 'http://localhost:8080/v1',
};
// each call passes options.apiKey: 'local'
```

Opus — built-in registry + auth resolution:

```ts
const auth = AuthStorage.create();
const registry = ModelRegistry.create(auth);
const opus = registry.find('anthropic', 'claude-opus-4-8');
const a = await registry.getApiKeyAndHeaders(opus);   // {apiKey, headers, env}
// completeSimple(opus, ctx, { apiKey: a.apiKey, headers: a.headers, env: a.env, reasoning: 'high' })  // omit temperature
```

Health-check (Stream 02): a 1-token `completeSimple` ping per local server + the Opus auth
resolution; fail fast with a clear per-endpoint message if a server is down or auth is missing.

**OAuth prompt authoring (D7).** Because the chosen Opus auth is Claude Pro/Max OAuth, the
pipeline cannot own `system[0]` (OAuth forces the Claude Code system prefix + beta headers). The
planner and arbiter persona — "you are the architect producing spec + rubric + tests" / "you are
the arbiter ruling on this deadlock" — and all role instructions are therefore delivered in the
**user message**, not the system prompt. Author these prompts to be self-contained in the user
turn and to survive the forced prefix; do not rely on a custom system persona for Opus.

The entrypoint must `import '@earendil-works/pi-ai'` (not `/base`) so providers register.

### Local model driving (empirical — validated against the live servers)

Both local models are served by llama.cpp (build `b9700`) and **honor `max_tokens` when it is sent** — but the two models must be driven differently, and a client-side bug exposed both to OOM:

- **OOM root cause (fixed).** pi-ai's openai-completions provider only emits `max_tokens` when truthy, and neither the `callRole` options nor the `pi-agent-core` Agent path (`createLoopConfig` → `buildBaseOptions`, no `model.maxTokens` fallback) ever set it — so **no length cap reached the wire**. A model that didn't stop on its own (see Gemma below) streamed unbounded output and OOM'd the Node process; `max_tokens`/`AbortSignal` couldn't help because the cap was never sent. Fix: **always send a finite `maxTokens`** — `callRole` sets it on every call, and the implementer wraps `streamFn` to inject `model.maxTokens` per turn (the Agent's turn-cap only bounds turn *count*, not tokens within a turn). This is the load-bearing safety rail for any local model.
- **Gemma reviewer = prompt-json, not tools.** Gemma 4 has no OpenAI `tools`/`tool_choice` interface (its function calling is a native DSL applied only by its chat template). Forcing an OpenAI tool sends off-distribution content with no native stop → degenerate runaway. Worse, this build emits a verbose harmony-style reasoning channel — `<|channel>thought … <channel|>{answer}` — in the **content**, and the reasoning echoes the schema. So Gate B drives Gemma with **no tools**: a prompt-instructed single JSON object (`structuredVia: "prompt-json"`), greedy (`temperature: 0`), with a generous bounded budget (`maxTokens` ~4096 — the thought channel is long), and the JSON is extracted from **after the last `<channel|>`** (parsing the first `{…}` would grab the schema echo inside the reasoning). `verdict` is a free string normalized fail-closed; `findings` are flat (no literal-union enums) for local-model reliability.
- **Qwen implementer = native OpenAI tool_calls.** Qwen3-Coder-Next on `:8081` returns proper streaming `tool_calls` out of the box (server-side Qwen tool template) and emits no reasoning/thinking tokens — so `createCodingTools` over real tool calls works unchanged; it needs only the per-turn `maxTokens` cap (above) and a low `temperature` for reproducible edits.
- **Context window.** Runtime `n_ctx` on the Qwen server is ~24576 (far below the model's trained context); `config.qwen.contextWindow` is set to match so context-budget math stays inside the real KV window.
- **Server-side recommendations (operator):** launch llama.cpp with `--jinja` (applies the model's chat template / correct EOS, suppresses Gemma ghost-thought spill) and keep the Qwen tool parser enabled; pin sampling there (pi-ai forwards only `temperature`/`maxTokens`, not `top_k`/`repetition_penalty`).
- **Upstream hardening (noted, not done here):** making `buildBaseOptions` fall back to `model.maxTokens` in pi-ai would close the missing-cap hole globally for all `streamSimple` callers; the pipeline doesn't depend on it because every pipeline model call now sends its own cap.

## 7. Structured output (`callRole`)

`callRole<T>(model, context, schema, toolName, options) => validated T`. It passes
`Context.tools = [{ name: toolName, description, parameters: schema }]` and `options.toolChoice`
(api-branched), accepts `stopReason === 'toolUse'`, reads the `toolCall` block, and validates
`arguments` with `Compile(schema).Check`. On invalid output it reprompts up to twice; on no
tool call it falls back to a no-`toolChoice` raw-JSON request and parses the first balanced
object; double failure throws a typed `RoleOutputError` that the FSM routes to `escalate`. This
is the single place the `SimpleStreamOptions` → `toolChoice` cast lives, and it is unit-tested
for both api branches.

## 8. Worktree isolation and the safety gate

`worktree.ts` shells out (no git-worktree primitive exists): `git worktree add <path> -b
pipeline/<runId>`, `git worktree remove --force <path>`, `git worktree prune` on startup.
Checkpoints use `git stash create` (content-addressed, never touches the stash stack) +
`git stash apply <ref>`; the dirty check is `git status --porcelain`.

`safety-gate.ts` is the implementer Agent's `beforeToolCall` (returns `{ block?, reason? }`).
For path-bearing tools it computes `canonicalizePath(resolvePath(input.path, worktree))` and
`canonicalizePath(worktree)`, then blocks unless `getCwdRelativePath(resolvedReal, worktreeReal)
!== undefined`. It **default-denies unknown tools** so a future path-bearing tool cannot silently
bypass, and writes an audit event per allow/block. The `protected-paths.ts` example is used only
as the `{block, reason}` *shape* — its substring `.includes()` is defeatable and is not the jail.
Bash is best-effort confined to the worktree cwd by default; with `config.sandbox='os'` it is
wrapped with the OS sandbox (darwin/linux), which must be promoted from a root devDep to a real
dependency of this package if enabled.

## 9. Stream-by-stream implementation map

- **01 foundation** — package skeleton + `orchestrator.ts` FSM + run-dir layout
  (`spec.md`, `rubric.md`, `tests/`, `findings/`, `decision-log.jsonl`, `summary.md`) + `cli.ts`.
- **02 model wiring** — `models.ts` (3 model objects, compat, auth) + `callRole.ts` + health-check.
- **03 Stage 0 plan** — `callRole(opus, …, PlanSchema, 'emit_plan', {reasoning:'high'})` producing
  `{spec, rubric[], tests[{path,content,intent}]}`; write tests to worktree; red-check asserts the
  test command exits non-zero before implement (vacuous plans rejected).
- **04 Stage 1 implement** — `implementer.ts`: `new Agent({ initialState:{ model: qwen,
  thinkingLevel:'off', tools: withFileMutationQueue(createCodingTools(worktree)) }, beforeToolCall:
  safetyGate, shouldStopAfterTurn: turnCap, getApiKey: () => 'local', onResponse: costSink })`;
  diff via `git status --porcelain`.
- **05 Gate A** — `gate-a.ts`: orchestrator-driven `execCommand` for test/lint/type, exit-code
  parse to `GateAResult`, distill compact failures, loop ≤ 4, AbortSignal/timeout.
- **06 Gate B** — `gate-b.ts`: `callRole(gemma, …, FindingsSchema, 'emit_findings')` over the
  non-testable layer; anti-rubber-stamp is a TS post-check (reject non-approve with empty findings;
  reprompt for citations) plus a rubric-coverage assertion; loop ≤ 3.
- **07 revise** — `revise.ts`: per finding fix (Agent) / defend (must cite constraint/test/spec
  clause or re-route open) / defer (`findings/deferred/` artifact); re-run Gate A then Gate B;
  `git stash create` checkpoint before each revise.
- **08 escalation** — `escalate.ts`: `callRole(opus, …, RulingSchema, 'arbitrate',
  {reasoning:'high'})` exactly once; resolution union `re_plan | side_reviewer | side_coder |
  needs_human`; human gate on `needs_human` (sync prompt, or halt when `autoApprove=false`).
- **09 Definition of Done** — smoke runner: `execCommand(config.smokeCmd, worktree)`, `code===0`
  required; smoke-fail routes back to `revise` with the bug. UI smoke (chrome-devtools/MCP bridge)
  is explicitly out of base scope — pi has no built-in primitive for it.
- **10 SafetyGate** — `safety-gate.ts` as in §8.
- **11 decision-log** — `decision-log.ts`: versioned JSONL (mirrors `JsonlSessionStorage`) that
  doubles as the resume journal + `summary.md` renderer (rounds-to-green, rounds-to-approve,
  escalation/cap-hit rate, per-role tokens/$). NATS publish stays optional/out of scope.
- **12 end-to-end** — `runPipeline` ties all phases; faux-driven integration + manual live-smoke.

## 10. Corrections to the existing specs

These are factual mismatches between the current `todo/` specs + `coding-pipeline.md` and how pi
actually works.

1. **Layer framing (README, `coding-pipeline.md` §5, every spec).** "pi-agent-core
   orchestrator/service" is wrong. The orchestrator is plain TS in an external consumer package;
   only the *implementer* uses pi-agent-core's `Agent`; the three thinking roles use pi-ai
   `completeSimple`.
2. **`callRole` / "cross-provider handoff" (02, `coding-pipeline.md` §5).** There is no
   cross-provider-handoff primitive. Opus is `getModel` + `ModelRegistry.getApiKeyAndHeaders`,
   called in the same process as the locals. `onResponse` is an Agent hook for cost capture,
   unrelated to provider handoff. `callRole` is not uniform across roles (single-shot for the
   faculties; an Agent loop for the coder).
3. **Gate A "tool-call/bash" (05, `coding-pipeline.md` §5).** Correct to orchestrator-driven
   `execCommand`; the model never runs the tests; the verdict is a process exit code.
4. **"grammar / JSON-schema-constrained structured output" (03, 06, `coding-pipeline.md` §5).**
   pi-ai has no `response_format`/`json_schema`/grammar. The only mechanism is a forced tool call
   validated by TypeBox (success = `stopReason 'toolUse'`), with reprompt + text fallback.
5. **"pi tool_call hook" / "ships permission-gate.ts/protected-paths.ts templates" (10,
   `coding-pipeline.md` §5).** The hook is the Agent's `beforeToolCall` callback
   (`{block?, reason?}`). `pi.on("tool_call")` is the `createAgentSession` extension name, which
   this design does not use. The example extensions are reference *shapes*, not drop-in templates.
6. **Path confinement (10).** It is not built in, and the jail must **canonicalize**:
   `resolvePath`/`getCwdRelativePath` are lexical-only, so an in-worktree symlink escapes. Apply
   `canonicalizePath` to both sides; default-deny unknown tools.
7. **"pi tool-dispatch (registerTool/AgentTool)" (04).** No `registerTool` in this path; tools
   come from `createCodingTools(worktree)` passed to `Agent.initialState.tools`.
8. **git worktree (§1/§4, 04/09).** No git-worktree primitive exists; shell out via `execCommand`.
9. **Model-port swap bug (12).** Spec 12 line 10 reads "Opus :8081 Qwen :8080 Gemma" — wrong.
   Correct: Qwen :8081, Gemma :8080, Opus = Anthropic cloud (no port). The §2 table is right.
10. **Local model config (02).** Local `Model<'openai-completions'>` literals must set the
    explicit `compat` block, `reasoning:false`, `cost {0,0,0,0}`, and pass `apiKey:'local'` or the
    provider hard-throws. This is invisible config validated only at the live-smoke layer.
11. **Subagent layer (`coding-pipeline.md` §5).** No native subagent/Task primitive exists; the
    orchestrator *is* the supervisor. Remove the implication of a built-in subagent layer (and the
    `Pi-Harness §…` cross-references, which point outside this repo's scope).
12. **Placement (01).** Resolve to `packages/build` (`private:true`), external consumer; drop
    the "app under the fork" alternative and the "pi-agent-core service" phrasing. Do not cite
    `packages/mom` as a precedent.
13. **Caps (07/12, `coding-pipeline.md` §7).** Caps are integer counters checked in TS before each
    role call; add AbortController/timeout so a hung turn/command cannot stall the cap loop.
14. **Decision log as resume journal (11, `coding-pipeline.md` §5).** `decision-log.jsonl` also
    doubles as the crash-resume/replay journal (journal-before-side-effect + `--resume` +
    startup stale-worktree prune). Add `config.sandbox='os'` as a documented opt-in OS-jail ring.

## 11. Test strategy

1. **Faux unit (no servers/keys; CI-safe under `./test.sh`).** `registerFauxProvider` with one
   registration per role-api. Faux is keyed per `{api, provider}`, and Qwen + Gemma both use
   `openai-completions` — so there is one openai-completions registration whose factory branches on
   `model.id` and asserts the received prompt, plus one anthropic registration for Opus. Factories
   return forced-tool `ToolCall` blocks with `stopReason 'toolUse'`. Unit-test: `callRole` (valid
   toolCall; invalid-then-reprompt; no-toolCall → text-fallback; double-fail → `RoleOutputError`;
   both api branches); Gate B anti-rubber-stamp + rubric-coverage; safety-gate jail with concrete
   escape vectors (absolute path, `../` traversal, in-worktree symlink, unknown tool); schema
   validate/reject.
2. **Integration (faux models, real git + real `execCommand` against a tmp fixture repo).** Drive
   `runPipeline` end-to-end through the full ladder with scripted faux responses; assert the JSONL
   replay reproduces the exact phase sequence; caps trigger escalation; `--resume` reconstructs
   state from a truncated journal and prunes the stale worktree; AbortController cancels cleanly.
3. **Manual live-smoke (out of CI, real servers).** 2–3 real tasks (one easy, one with a
   tests-catch edge case, one designed to deadlock) with Qwen :8081, Gemma :8080, Opus via
   `ANTHROPIC_API_KEY`. The only layer that validates the local `compat` block, real forced-tool
   reliability on the local models, and Opus auth/cost. Capture decision-logs and tune the caps.

`npm run check` (biome `--error-on-warnings`, check:pinned-deps, check:ts-imports,
check:shrinkwrap, tsgo `--noEmit`) gates style/erasable-TS/imports but does not run tests.

## 12. Risks

- **Local-model tool-calling reliability (#1 risk).** Qwen/Gemma may emit no/malformed forced
  tool call → `callRole` reprompt + text-JSON fallback → escalate on persistent failure. Validate
  at the live-smoke layer; consider `compat.thinkingFormat` tuning and smaller schemas.
- **Symlink jail bypass.** Mitigated by `canonicalizePath` on both sides + a dedicated escape-vector
  test; the disposable worktree bounds residual blast radius.
- **Best-effort bash confinement (default).** A bash command can touch absolute paths outside the
  worktree; the tree only protects itself. For untrusted tasks enable `config.sandbox='os'`.
- **Vendor drift.** Frozen copies won't receive upstream fixes → provenance header + jail-behavior
  unit test.
- **Per-tool path-arg map.** A future coding tool with a new path param could bypass the jail →
  default-deny unknown tools.
- **Shared openai-completions faux registration.** The Qwen/Gemma test factory must discriminate by
  `model.id`; mandatory id assertions in every factory.
- **`toolChoice` cast.** Rides through a `SimpleStreamOptions` cast localized to `callRole`;
  covered by a unit test.
- **Arbitration cost.** Opus calls accrue tokens (a notional `usage.cost` under the chosen OAuth
  subscription, not a per-token charge) → gate caps + exactly one arbitration per escalation before
  human handoff still bound the volume.
- **Crash mid-worktree-create.** Startup `git worktree prune` + `pipeline/*` cleanup; SIGKILL
  residue needs a manual prune.

## 13. Locked decisions (owner: James)

1. **`config.sandbox` default = `none`** — portable disposable-worktree + canonicalizing path jail
   is the default (no extra runtime dep). OS sandbox (`config.sandbox='os'`, darwin/linux) remains
   available as opt-in and, if enabled, promotes `@anthropic-ai/sandbox-runtime` to a real
   dependency of this package.
2. **Opus auth = Claude Pro/Max OAuth** — planner/arbiter persona + instructions are authored in
   the user turn (the pipeline cannot own `system[0]` under OAuth). See §6 "OAuth prompt authoring".
3. **Live-smoke = CLI/API only** — the DoD smoke runs `config.smokeCmd` via `execCommand`. UI smoke
   (chrome-devtools/MCP bridge) is out of scope.
4. **Default caps = gateA 4 / gateB 3 / revise 3** (default; tune from decision-log data).
5. **Resume = phase-boundary only** (default; journal + `--resume`; no mid-turn resume).
