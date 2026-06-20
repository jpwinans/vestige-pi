# @earendil-works/pi-pipeline

A local, deterministic multi-model coding pipeline built on pi. A plain TypeScript
state machine is the sole supervisor; models are called only at role-points.

**Phase 1 (this package) is local-only — no Anthropic leg:**

- **Implementer** — Qwen3-Coder (local, `http://localhost:8081/v1`) runs as one
  `pi-agent-core` Agent loop, confined to a disposable git worktree by a
  `beforeToolCall` jail.
- **Reviewer** — Gemma (local, `http://localhost:8080/v1`) reviews the non-testable
  layer against the plan's rubric via a forced-tool structured output.
- **Gate A** — tests/lint/typecheck run via `execCommand`; the verdict is a process
  exit code, never a model claim.
- **Planning** is human-authored: the plan (spec + rubric + failing tests) is created
  with the `build-plan` Claude skill and passed to the pipeline as a directory.
- **Escalation** halts at the human (no Opus arbiter in Phase 1).

Phase 2 adds the Anthropic leg back (Opus planner + arbiter).

## Run

```
# headless CLI
pipeline run ./plans/<slug>/

# from the pi TUI (via the coding-agent extension)
/build ./plans/<slug>/
```

A plan directory contains `plan.json` (commands + test paths), `spec.md`, `rubric.md`,
and `tests/` (each test mirrored at its repo-relative path). See
`.claude/skills/build-plan` for the authoring workflow and the exact format.

## Flow

```
plan -> red_check -> implement -> gate_a -> gate_b -> revise -> escalate -> done
```

Caps: Gate A 4, Gate B 3, revise 3 (tune from the decision log). Every transition is
journaled to `decision-log.jsonl` in the run directory, which doubles as the replay tape.

See `docs/coding-pipeline-architecture.md` for the full design.
