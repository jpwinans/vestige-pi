# Changelog

## [Unreleased]

### Added

- Phase 1 of the local multi-model coding pipeline (`@earendil-works/pi-pipeline`): a
  deterministic TypeScript orchestrator that drives a local Qwen implementer (one
  `pi-agent-core` Agent loop) and a local Gemma reviewer (forced-tool structured
  output) through the loop `plan -> red_check -> implement -> gate_a -> gate_b ->
  revise -> escalate -> done`.
- `callRole` structured-output helper (forced tool call + TypeBox validation + reprompt
  + text-JSON fallback), since pi-ai has no `response_format` mode.
- Worktree-confined SafetyGate (`beforeToolCall`) with canonicalizing path containment
  and default-deny on unknown tools.
- Orchestrator-driven Gate A (test/lint/typecheck via `execCommand`), Stage-0 red-check,
  and Definition-of-Done live-smoke.
- JSONL decision log + run summary; `/build` coding-agent extension and `pipeline run`
  CLI entrypoints over a shared `runPipeline` core.
- The `build-plan` Claude skill for authoring the plan artifact (spec + rubric + failing
  tests) the pipeline consumes.
- Live integration test (`test/integration.live.test.ts`) that exercises the real local
  models (health check, structured output on both, a bounded Gate B review). Gated on
  reachability + `PI_NO_LOCAL_LLM` so it runs on a direct `vitest` and is skipped under
  `./test.sh`/CI.

### Fixed

- Unbounded local-model generation could OOM the process: `callRole`, the implementer
  Agent (via a `streamFn` wrapper), and the health check now always send a finite
  `max_tokens` (pi-ai drops the field when falsy, so omitting it removed the only length
  cap), plus a per-call timeout.
- Gate B now drives Gemma via a no-tools prompt-json path with harmony-channel-aware JSON
  extraction (parses the answer after the last `<channel|>`), greedy sampling, and a
  bounded budget — forcing an OpenAI tool on Gemma 4 (which has no such interface) caused
  a degenerate runaway. Qwen keeps the native OpenAI tool-call path.
- Role-output schemas flattened for local-model reliability: `verdict` is a free string
  normalized fail-closed; findings carry only two required fields, no literal-union enums.
