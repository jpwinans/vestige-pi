# Coding Pipeline — Architecture

A local, multi-model coding pipeline that takes a pre-authored plan (a spec, a review rubric, and
failing tests) and drives it to a tested, reviewed, live-smoke-passing change inside an isolated git
worktree. It lives in `packages/pipeline` and is built on the pi packages in this repo.

The control flow is discipline-as-code: a deterministic TypeScript state machine is the sole
supervisor and an LLM never decides what happens next. Models are called only at role-points; the
loop, the gates, the caps, and the escalation are TypeScript.

## 1. Roles and endpoints

| Role | Who | Endpoint | How it is driven |
|------|-----|----------|------------------|
| Planner | A human (assisted), ahead of the run | — | Authors the plan directory; not a pipeline model call |
| Implementer | Qwen3-Coder-Next | `http://localhost:8081/v1` | A `pi-agent-core` `Agent` loop over OpenAI tool calls |
| Reviewer | gemma-4-26B-A4B-it | `http://localhost:8080/v1` | A single-shot completion returning JSON in text |
| Arbiter | A human (the operator) | — | The escalation gate on any cap or deadlock |

The two model roles run locally behind OpenAI-compatible endpoints, expressed as plain
`Model<'openai-completions'>` objects. The pipeline is self-contained: it needs no cloud model and
no network beyond the two local servers.

The architecture has one extension point reserved for a cloud model: automated planning (turning a
free-text task into a plan) and automated arbitration (ruling on a deadlock before it reaches the
human). Both are role-points the state machine already has slots for; neither is part of the
local pipeline described here.

## 2. Package and components

`packages/pipeline` (`@earendil-works/pi-pipeline`, `private: true`) is an external consumer of pi's
public APIs. It builds with `tsgo` like the other packages and adds no published surface.

```
packages/pipeline/src/
  cli.ts            # `pipeline run <plan-dir>` entrypoint
  extension.ts      # coding-agent extension registering the /build command
  index.ts          # public exports
  orchestrator.ts   # the finite state machine (runPipeline)
  config.ts         # PipelineConfig + defaults
  types.ts          # hooks, run result, escalation types
  schemas.ts        # TypeBox role-output schemas + Phase/DecisionEvent unions
  plan-loader.ts    # read + validate a plan directory
  call-role.ts      # structured single-shot model call (tool or prompt-json)
  models.ts         # build the local Model objects + startup health check
  implementer.ts    # the Qwen Agent loop
  gate-a.ts         # test/lint/type runner, red-check, live-smoke
  gate-b.ts         # the Gemma review
  revise.ts         # fix/defend/defer classification + deferred artifacts
  escalate.ts       # human-gate resolution
  worktree.ts       # disposable git worktree lifecycle
  decision-log.ts   # append-only JSONL log + run summary
  safety-gate.ts    # the worktree jail (beforeToolCall)
  vendor/exec.ts    # vendored execCommand
  vendor/paths.ts   # vendored path utilities
```

Most runtime weight is reused pi machinery: the provider stack and `completeSimple`/`streamSimple`
(`@earendil-works/pi-ai`), the `Agent` tool loop (`@earendil-works/pi-agent-core`), and
`createCodingTools` (`@earendil-works/pi-coding-agent`). `vendor/` holds frozen copies (with a
provenance header) of two helpers that pi does not export from a public entry point: `execCommand`
and the path utilities `resolvePath` / `getCwdRelativePath` / `normalizePath` / `canonicalizePath`.

## 3. The plan (input contract)

A run consumes a plan directory:

```
plans/<slug>/
  plan.json   # { slug, goal, commands: { test, lint?, typecheck?, smoke? } }
  spec.md     # the specification
  rubric.md   # review criteria, one per checklist line
  tests/      # test files, each mirrored at its real repo-relative path
```

`plan-loader.ts` validates `plan.json` against a TypeBox schema and maps the directory to an
in-memory `Plan`: `spec` from `spec.md`, `rubric` from the `rubric.md` checklist lines, `tests` from
walking `tests/**` (each file's path under `tests/` is its target repo path), and `commands` from
`plan.json`. A plan with no tests or an empty rubric is rejected at load time.

The plan is authored ahead of the run (the repo ships a `build-plan` planning skill that produces a
conforming directory and proves the tests fail before handoff). The pipeline itself only consumes
the directory.

## 4. Control flow

The state machine lives in `orchestrator.ts` as `runPipeline(planDir, config, hooks)` — a linear
async function with bounded `for` loops for the gates, not a model-driven dispatcher. Phases are the
labels carried in the decision log (a string-literal union, no `enum`); `plan` is the setup stage
before the first numbered phase, and the terminal outcome is a RunStatus, not a phase:

```ts
type Phase = 'plan' | 'red_check' | 'implement' | 'gate_a' | 'gate_b' | 'revise' | 'escalate';
```

A run proceeds:

1. **Load & health check.** Load the plan; ping both local endpoints with a one-token completion and
   fail fast if either is down.
2. **Worktree.** Prune stale pipeline worktrees, then create a fresh one on a `pipeline/<runId>`
   branch.
3. **Red-check.** Write the plan's tests into the worktree and run the test command; it must exit
   non-zero. Tests that already pass mean the plan is vacuous, which escalates.
4. **Gate A (objective), up to `caps.gateA` rounds.** The implementer edits the worktree; the
   orchestrator runs test/lint/typecheck and decides pass/fail from exit codes. A failing round
   feeds a distilled failure summary back to the implementer and repeats. Exceeding the cap
   escalates.
5. **Gate B (review) + revise, up to `caps.gateB` rounds.** The reviewer grades the diff against the
   rubric. On approval the run proceeds; otherwise the implementer classifies each finding
   (fix / defend / defer), the orchestrator applies fixes and re-runs Gate A then Gate B. Exceeding
   the cap escalates.
6. **Definition of Done.** Run the live-smoke command (the plan's real entrypoint). Only a passing
   smoke marks the run `done`.
7. **Escalation.** Any cap or deadlock routes to the human gate (see §8). A `summary.md` is always
   written and the worktree removed when the run ends.

Caps are integer counters checked before each role call, so the loop is bounded by attempts. Every
model call carries a per-call timeout and the run carries an `AbortSignal`, so a hung turn or
command cannot stall the loop on wall-clock.

Every transition and result is appended to an append-only JSONL decision log
(`decision-log.ts`), whose events form a typed discriminated union:

```ts
type DecisionEvent =
  | { type: 'run_start'; runId; planSlug }
  | { type: 'phase_enter'; phase; attempt }
  | { type: 'red_check'; passed; exitCode }
  | { type: 'implement'; attempt; stopReason }
  | { type: 'gate_a'; attempt; passed; summary }
  | { type: 'gate_b'; attempt; verdict; findingCount }
  | { type: 'revise'; fixed; defended; deferred }
  | { type: 'escalate'; reason }
  | { type: 'done'; smokePassed }
  | { type: 'usage'; role; model; tokens; costUsd }
  | { type: 'error'; phase; message };
```

The log is the audit trail and the source for `summary.md` (rounds per gate, escalations, per-role
token usage). Each event is journaled before its side effect; the current entrypoint runs a fresh
run each invocation (no resume).

## 5. Structured output (`call-role.ts`)

pi's provider layer has no JSON-schema/grammar response mode, so a role that must return a typed
object is handled by `callRole(model, context, schema, toolName, description, opts)`, which returns a
TypeBox-validated value. It supports two strategies, selected per model:

- **`tool`** — pass the schema as an OpenAI tool and force the call, then validate the returned
  arguments. Used for models with native OpenAI tool calling (the implementer's classification step).
- **`prompt-json`** — send no tools; ask for a single JSON object in the text and parse it. Used for
  the reviewer (see §6).

Both strategies validate against the schema and, on invalid or missing output, reprompt with the
concrete validation error up to `maxReprompts` times before throwing a typed `RoleOutputError`. The
`tool` strategy additionally falls back to a `prompt-json` attempt.

Every call sends a finite `maxTokens` and a timeout. The provider omits `max_tokens` from the
request when it is unset, which would leave generation unbounded; sending a finite cap on every call
is the design invariant that keeps a verbose or degenerate local generation from growing without
limit.

## 6. Driving the local models

The two local models are served the same way (llama.cpp behind an OpenAI-compatible API) but expose
different contracts, so each is driven to its strengths:

- **Qwen (implementer)** speaks native OpenAI tool calling and emits no reasoning channel, so it runs
  as a normal `Agent` loop over `createCodingTools` (read/edit/write/bash). The Agent does not forward
  a token cap to the provider, so `implementer.ts` supplies a `streamFn` that injects a per-turn
  `maxTokens` (and a low temperature for reproducible edits) on every turn.
- **Gemma (reviewer)** has no OpenAI tool interface — its function calling is a native template
  format — and it emits a verbose reasoning channel of the form `<|channel>thought … <channel|>`
  before its answer. It is therefore driven with `prompt-json`: no tools, greedy sampling, and a
  generous token budget so the reasoning plus the answer both fit. The answer JSON is extracted from
  the text after the last `<channel|>` marker (the reasoning preceding it echoes the schema, so
  parsing the first object would capture the wrong one). The review `verdict` is a free string
  normalized fail-closed (anything but `approve` is treated as `request_changes`), and findings are
  flat with no enum fields, both for local-model reliability.

`models.ts` builds each `Model<'openai-completions'>` with an explicit `compat` block (the localhost
endpoints are not auto-detected) and `reasoning: false`. Local providers receive no environment API
key, so each call passes a non-empty placeholder key. Token caps and context windows are sized to the
servers' runtime limits (see §10).

## 7. Worktree isolation and the safety gate

`worktree.ts` shells out via the vendored `execCommand` (array args, `shell:false`): a run gets a
fresh worktree on a throwaway branch (`git worktree add -b pipeline/<runId>`), stale worktrees are
pruned on startup, and the worktree is removed when the run ends. The diff handed to the reviewer is
produced with `git add -A` + `git diff --cached` so new files are included.

`safety-gate.ts` is the implementer Agent's `beforeToolCall` hook. It default-denies any tool not on
the coding allowlist. For path-bearing tools it canonicalizes both the resolved target path and the
worktree root (following symlinks) and blocks anything that resolves outside the worktree —
canonicalization is what prevents an in-worktree symlink from escaping the jail, which a purely
lexical path check would miss. Bash is confined to the worktree working directory; because the
worktree is disposable, a bash command that reaches outside it is contained by being thrown away with
the tree.

## 8. Escalation

There is no automated arbiter, so any cap exceeded or deadlock halts the run and notifies the
operator via `hooks.onEscalation` (in the TUI, a dialog; absent the hook, the run simply halts). The
escalation is recorded in the log and the run ends rather than looping.

## 9. Invocation surfaces

The orchestrator core, `runPipeline(planDir, config, hooks)`, is invocation-agnostic; `hooks`
carries an optional `onEvent` (decision-event stream), `onEscalation` (halt notification), and a
`signal`. Two thin adapters share it:

- **`pipeline run <plan-dir>`** (`cli.ts`) — a headless terminal run that prints decision events.
- **`/build <plan-dir>`** (`extension.ts`) — a coding-agent slash command. It runs the pipeline
  out-of-band of the host TUI's own agent loop (the pipeline is a separate supervised process, not a
  prompt to the current model), streaming progress to the UI and notifying the operator on
  escalation. `extension.ts` is the only file coupled to the coding-agent runtime; the core and CLI
  are independent of it.

## 10. Configuration

`config.ts` provides `PipelineConfig` with these defaults:

- **Endpoints** — Qwen `http://localhost:8081/v1` (context window 24576, per-turn cap 8192); Gemma
  `http://localhost:8080/v1` (context window 131072, review cap 4096). The windows track the servers'
  runtime context so context-budget math stays inside the real limit.
- **Caps** — Gate A 4 rounds, Gate B 3 rounds (the revise loop is bounded by the Gate B cap). These
  are starting values, intended to be tuned from decision-log data.
- **Sandbox** — `none`: the disposable worktree plus the canonicalizing path gate. An optional `os`
  mode wraps bash in an OS sandbox (darwin/linux) and, if used, makes the sandbox runtime a real
  dependency of this package.
- **Implementer** — up to 30 turns per attempt; near-deterministic temperature.
- **Command timeout** — 10 minutes per gate/smoke command.

Operators run llama.cpp with its chat template applied (so EOS and tool templates are correct) and
pin sampling at the server, since the provider forwards only `temperature` and `maxTokens`.

## 11. Testing

- **Unit tests** use pi's faux provider (no servers, no keys; CI-safe). They cover `callRole` (both
  strategies, reprompt, fallback, and the error path), the safety gate against concrete escape
  vectors (absolute path, `..` traversal, in-worktree symlink, unknown tool), the plan loader, and
  the exit-code-driven Gate A runner.
- **A live integration test** (`test/integration.live.test.ts`) exercises the real local models: it
  health-checks both endpoints, obtains schema-valid structured output from each (Qwen via tool call,
  Gemma via prompt-json), and runs a bounded Gate B review. It is gated on endpoint reachability and
  the `PI_NO_LOCAL_LLM` flag, so it runs on a direct `vitest` invocation and is skipped under the
  repo's standard test runner and in CI.

## 12. Limitations

- **Reviewer reliability** depends on the local model producing valid JSON; the reprompt loop and a
  bounded token budget make a bad response fail gracefully rather than stall or grow unbounded.
- **Bash confinement** is best-effort (working directory plus the disposable worktree) unless the
  optional OS sandbox is enabled.
- **Vendored helpers** are frozen copies; a behavioral unit test guards the jail so a divergence is
  caught where it matters.
- **Resume** is not implemented; each invocation is a fresh run (the journal-before-side-effect log
  is the foundation for adding it).
