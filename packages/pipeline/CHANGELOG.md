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
