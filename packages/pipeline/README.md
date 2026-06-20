# @earendil-works/pi-pipeline

A local, deterministic multi-model coding pipeline built on pi. A plain TypeScript
state machine is the sole supervisor; models are called only at role-points. It is
local-only — two OpenAI-compatible endpoints, no cloud model.

- **Implementer** — Qwen3-Coder (local, `http://localhost:8081/v1`) runs as one
  `pi-agent-core` Agent loop over native tool calls, confined to a disposable git
  worktree by a `beforeToolCall` jail.
- **Reviewer** — Gemma (local, `http://localhost:8080/v1`) reviews the non-testable
  layer against the plan's rubric via a prompt-json structured output (no tools —
  Gemma has no OpenAI tool interface).
- **Gate A** — tests/lint/typecheck run via `execCommand`; the verdict is a process
  exit code, never a model claim.
- **Planning** is human-authored: the plan (spec + rubric + failing tests) is passed
  to the pipeline as a directory.
- **Escalation** halts the run and notifies the operator (there is no automated
  arbiter). A cloud planner/arbiter is a reserved future extension, not part of this
  package.

## Run

```
# headless CLI
pipeline run ./plans/<slug>/

# from the pi TUI (via the coding-agent extension)
/build ./plans/<slug>/
```

A plan directory contains `plan.json` (commands), `spec.md`, `rubric.md`, and `tests/`
(each test mirrored at its repo-relative path).

## Flow

```
plan -> red_check -> implement -> gate_a -> gate_b -> revise -> escalate -> done
```

Caps: Gate A 4 rounds, Gate B 3 rounds (revise is bounded by the Gate B cap). Every
event is journaled to `decision-log.jsonl` in the run directory.

See `docs/coding-pipeline-architecture.md` for the full design.
