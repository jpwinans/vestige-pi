# Plan format

The on-disk contract for a `/build` plan. The pipeline's plan loader reads exactly this layout, so
follow it precisely. A plan is a directory, conventionally `plans/<slug>/`, where `<slug>` is a
short kebab-case name for the build (e.g. `plans/dedupe-session-entries/`).

## Directory layout

```
plans/<slug>/
  plan.json     # manifest: slug, commands, pointers (machine-read by the pipeline)
  spec.md       # the specification (the build contract)
  rubric.md     # review criteria for Gemma (the non-testable layer)
  tests/        # failing tests, mirrored at their real repo paths
    <repo-relative-path>...
```

All four are required (except `tests/` may be a single file's worth — but there must be at least
one failing test).

## `plan.json`

The manifest the pipeline reads for the deterministic parts of the run. Keep it minimal and exact.

```json
{
  "slug": "dedupe-session-entries",
  "goal": "One-line summary of what this build produces.",
  "commands": {
    "test": "node ../../node_modules/vitest/dist/cli.js --run test/dedupe.test.ts",
    "lint": "npm run check",
    "typecheck": "npx tsgo --noEmit",
    "smoke": "node ./dist/cli.js dedupe --dry-run ./fixture"
  }
}
```

Field notes:

- `commands.test` — **scoped to this plan's tests only**, never the full suite. This is what Gate A
  runs and re-runs each repair round. It must be runnable from the repo root (or state the cwd).
- `commands.lint` / `commands.typecheck` — optional; include them if the build should be held to
  them. In this repo, `npm run check` is the lint/type/format gate.
- `commands.smoke` — optional; the Definition-of-Done live-smoke: the change exercised through its
  **real entrypoint** (CLI command, API call). Exit code 0 = pass. This is what makes "it runs
  live" real. Describe that entrypoint in `spec.md` under "Live-smoke surface".

The tests are not listed in the manifest — the pipeline discovers them by walking `tests/` (see the
mirroring rule below).

## `spec.md`

The build contract. Concrete, behavior-first. Use this structure:

```markdown
# <Title>

## Goal
What should exist after this build that doesn't now. One or two sentences.

## Behavior
What it does from the outside: inputs, outputs, the cases that matter. Be specific — this is what
the implementer codes against and what the tests encode. Cover the edge cases explicitly.

## Constraints
What it must not break; performance/compat/style requirements; anything load-bearing.

## Non-goals
What is explicitly out of scope, so the build doesn't sprawl.

## Live-smoke surface
The real entrypoint a user touches, and how to invoke it (matches `commands.smoke`). The build is
not done until this runs.
```

Prefer describing observable behavior over prescribing implementation — let the implementer choose
the how, within the constraints.

## `rubric.md`

A flat checklist. Each line is **one criterion Gemma can verify by reading the diff**, covering the
*non-testable* layer. Format:

```markdown
# Review rubric

- [ ] <criterion that is checkable by inspection>
- [ ] <another>
```

Good rubric criteria target what tests can't:

- **Spec-conformance** — "Handles the empty-input case described in the spec's Behavior section."
- **Design** — "New parsing logic reuses the existing `parseEntry` helper rather than
  re-implementing it."
- **Missed edge cases** — "Rejects malformed timestamps instead of silently coercing them."
- **Readability / safety** — "No `any`; public functions are named for what they return."

Avoid criteria the tests already prove ("the dedupe function works" — that's Gate A's job). Each
criterion should be specific enough that two reviewers would agree whether the diff meets it.

## `tests/` — the path-mirroring rule

Each test file lives under `tests/` at its **real repo-relative path**. The directory structure
*is* the placement instruction — the pipeline copies `tests/<path>` into the worktree at `<path>`.

Example: a test that belongs at `packages/agent/test/dedupe.test.ts` in the repo is written to:

```
plans/dedupe-session-entries/tests/packages/agent/test/dedupe.test.ts
```

The pipeline writes it into the worktree at `packages/agent/test/dedupe.test.ts`; nothing else needs
to list it.

Requirements:

- Real tests in the repo's framework (vitest here), using the repo's conventions and placement.
- They must **fail red** against the current code — describing behavior that doesn't exist yet —
  and fail for the *right* reason (assertion/missing-impl, not a collection or import error).
- Assertions must pin exact behavior. The implementer iterates toward green against these, so
  loose assertions produce loose implementations.

## Worked example (abbreviated)

```
plans/dedupe-session-entries/
  plan.json
  spec.md
  rubric.md
  tests/
    packages/agent/test/dedupe.test.ts
```

`tests/packages/agent/test/dedupe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { dedupeEntries } from "../src/harness/session/dedupe.ts"; // does not exist yet -> red

describe("dedupeEntries", () => {
  it("removes entries with duplicate ids, keeping the last", () => {
    const out = dedupeEntries([
      { id: "a", v: 1 }, { id: "b", v: 2 }, { id: "a", v: 3 },
    ]);
    expect(out).toEqual([{ id: "b", v: 2 }, { id: "a", v: 3 }]);
  });

  it("returns an empty array unchanged", () => {
    expect(dedupeEntries([])).toEqual([]);
  });
});
```

Running the scoped test command against the current tree fails because
`src/harness/session/dedupe.ts` does not exist — a correct red state. The pipeline then drives the
implementer to make it green, Gemma reviews the diff against `rubric.md`, and the `smoke` command
confirms it runs live.

## How the pipeline consumes the plan

The pipeline's loader maps this directory to its internal plan object: `spec` from `spec.md`,
`rubric` from the `rubric.md` checklist items, `tests` from walking `tests/**` (path =
position under `tests/`, content = file body), and `commands` from `plan.json`. Stage 0 then writes
the tests into a fresh git worktree and runs the red-check (`commands.test` must exit non-zero)
before any implementation begins. A plan whose tests don't fail red is rejected — which is why this
skill proves the red state before handing off.
