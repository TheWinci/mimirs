---
name: plan
description: Design an implementation plan before writing code — where the change lands, what it will touch, what could break, and the steps in order. Use when asked to plan a feature, scope a change, or figure out how to approach an edit before making it. To assess a change that already exists (a diff, refactor, or rename), use review instead.
---

# Plan

Goal: a concrete, ordered plan grounded in real source — and the blast radius of each proposed change *before* writing it.

1. **Understand the area** — `search "<feature/topic>"` for the relevant files, then `read_relevant "<behavior>"` to read the actual functions/sections with line ranges. Don't plan against guessed code.
2. **Where it lands** — `write_relevant "<what you're adding>"` for the best insertion point (file + anchor) for new code; `project_map(focus: <key file>)` for how the target neighborhood connects.
3. **Impact of the change** — for each symbol you intend to modify: `impact <symbol>` (transitive callers as a pruned tree + the tests to run) so the plan accounts for every caller it ripples to. Widen with `usages <symbol>` (call sites) and `dependents <file>` (file-level importers). `trace from=<a> to=<b>` to confirm two symbols actually connect before relying on the path.
4. **Prior decisions & caveats** — `search_checkpoints "<area>"` and `search_commits "<area>"` so the plan doesn't undo a deliberate choice; `get_annotations` on the files you'll touch for known bugs, constraints, or "don't refactor until X".
5. **Resolve open decisions** — before drafting, surface the choices the source doesn't settle (approach, scope, naming, tradeoffs) and ask the user. Don't guess past a fork that changes the plan; one round of focused questions beats a plan built on a wrong assumption.
6. **Draft the plan** — ordered steps, each naming the `file:line` to edit, what changes, the callers it impacts (from step 3), and the tests to run. Call out risks and remaining open questions instead of hiding them.

Finish: present the plan for review before implementing — steps in order, impact per step, tests to run, prior decisions respected, each with a `file:line` citation. Let the user review before acting.
