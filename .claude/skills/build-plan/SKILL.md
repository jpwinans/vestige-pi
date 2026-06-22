---
name: build-plan
description: >-
  Interactively author a pipeline-ready plan — a spec, a review rubric, and failing tests — for
  the local /build coding pipeline (Qwen implements, Gemma reviews). Use whenever the user wants
  to plan or scope a coding task for /build: they say "/build-plan", "plan a build", "write a
  spec for the pipeline", "set up a plan for /build", "make the spec+rubric+tests for X", or want
  to turn a feature idea into the artifact the pipeline consumes — even if they don't name the
  artifacts explicitly. This is the human-in-the-loop planner that stands in for the pipeline's
  Opus Stage-0 step in Phase 1.
---

# build-plan

Author the plan that the local `/build` coding pipeline consumes. The plan is three artifacts in a
directory: a **spec**, a **review rubric**, and a set of **failing tests**. You produce them
through a real back-and-forth about what is being built, then prove the tests fail red, then hand
the user the `/build` command to run.

## Why this matters

In the pipeline, the plan is everything downstream depends on. Qwen (a local model) implements
against it, Gate A runs the tests, Gemma (a different local model) reviews against the rubric, and
the run isn't done until the change runs live. The models never see the original intent — only this
plan. So **spec quality dominates the outcome**: a vague or incomplete plan produces a vague,
thrashing build. Invest here.

Two more consequences shape how you write:

- **Local models can't act on vague feedback.** The tests and rubric must be concrete (exact
  behavior, exact criteria), because a small model can't infer what "make it better" means.
- **The plan divides labor across the two gates.** Tests carry the *objective* layer (Gate A:
  does it run, do the cases pass). The rubric carries the *non-testable* layer (Gate B: design,
  spec-conformance, edge cases the tests miss, readability). Don't make the rubric re-check what
  the tests already prove — that's wasted review and invites rubber-stamping.

## Workflow

Work through these in order. Don't jump to writing files until the shape is clear — the
conversation is the point.

### 1. Understand through back-and-forth

Have a real conversation before writing anything. Ask focused questions, ideally one thread at a
time, and reflect back your understanding so the user can correct it. Cover:

- **The goal** — what should exist after this build that doesn't now? In one or two sentences.
- **Observable behavior** — what does it *do*, from the outside? Inputs, outputs, the cases that
  matter, the cases that are easy to get wrong (edge cases are where tests earn their keep).
- **The real surface** — what entrypoint does a user actually touch (a CLI command, an API call,
  a function exported from a package)? This becomes the Definition-of-Done live-smoke. "It runs
  live" is checked against *this* surface, not a synthetic call.
- **Constraints and non-goals** — what must it not break, what's explicitly out of scope. Naming
  non-goals keeps the build from sprawling.
- **Scope sanity** — if the task is large, say so and help the user cut it to one coherent build.
  Several small plans beat one sprawling one.

Keep going until you could explain the task back to the user and they'd agree. If the user already
gave you a crisp description, confirm it and move on — don't pad the conversation.

### 2. Investigate the code

Before writing the spec or any test, read the relevant code **in full** (not search snippets) so
the plan matches how the repo actually works — its patterns, the framework, where similar things
live. For a test that exercises a flow end to end, trace the flow first. A plan written against an
imagined codebase produces tests that don't even collect.

### 3. Write the spec (`spec.md`)

The contract for the build. Be specific and concrete; prefer observable behavior over
implementation prescription (let Qwen choose the how, within the constraints). Structure it as in
`references/plan-format.md`. The spec must name the live-smoke surface explicitly.

### 4. Write the rubric (`rubric.md`)

The criteria Gemma grades against — each one **inspectable by reading the diff**, each covering the
non-testable layer (spec-conformance, design, missed edge cases, readability, safety). A fixed,
written rubric is what stops the review bar from drifting. Don't list anything the tests already
verify. See the rubric guidance in `references/plan-format.md`.

### 5. Write failing tests (`tests/`)

Real tests in the repo's framework, placed at their **real repo paths mirrored under `tests/`**
(see the path-mirroring rule in `references/plan-format.md`). They must describe behavior that does
not exist yet, so they fail red. Write the test command **scoped** to just these tests — never the
full suite. Tests are the spine of the objective gate; make each assertion pin an exact behavior.

### 6. Prove the tests fail red

This is the quality gate that catches a bad plan before the user wastes a build run. Run the scoped
test command against the current (unmodified) code and confirm:

- The tests **collect/compile** cleanly (no import or syntax errors), and
- They **fail for the right reason** — a missing implementation or an assertion mismatch, **not**
  a collection error, a typo, or a wrong import.

If a test passes against the current code, it's vacuous — it isn't testing the new behavior.
Rewrite it. A plan whose tests don't fail red is not ready; fix it before handing off.

### 7. Hand off

Write `plan.json` (the manifest — see the format reference), then tell the user the exact command:

```
/build ./plans/<slug>/
```

Briefly summarize what you produced (the goal, how many tests, the live-smoke surface) so the user
can sanity-check before running.

## Output contract

The precise on-disk format the pipeline reads — directory layout, `plan.json` schema, the
`tests/` path-mirroring rule, the rubric format, and a worked example — is in
**`references/plan-format.md`**. Read it before writing files; the pipeline's loader depends on
this contract exactly.

## Guardrails

- **Do not implement the feature.** Your job is the plan (spec + rubric + failing tests). The
  pipeline's implementer writes the code. If you write the implementation, the tests won't fail red
  and there's nothing for the pipeline to do.
- **Scope the test command.** Run only the plan's tests, never the whole suite (in this repo the
  full vitest run activates e2e tests and is forbidden — use a path-scoped run or `./test.sh`).
- **Follow the repo's test conventions.** Use the existing framework and placement (e.g. in this
  repo, regression tests live under the documented suite directory; consult AGENTS.md). Tests the
  pipeline can't run are worthless.
- **Concrete over aspirational.** Every rubric criterion must be checkable by reading the diff;
  every test assertion must pin a specific behavior. Vague criteria and loose tests are the main
  failure mode, because the local models can't fill the gaps.
