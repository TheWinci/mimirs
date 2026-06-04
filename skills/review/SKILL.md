---
name: review
description: Assess the blast radius of a change and review a diff — what it touches, what could break, which tests to run, and the prior decisions behind it. Use before a refactor, rename, or signature change, and when reviewing a pull request or your own uncommitted diff.
---

# Review

Goal: know the full impact before and after changing code — no surprise breakage.

1. **What changed** — `git_context(include_diff: true)` for the modified files and the diff.
2. **Blast radius** — for each changed function or type: `impact <symbol>` (transitive callers as a pruned tree + the tests to run). Widen with `usages <symbol>` (every call site) and `dependents <file>` (file-level importers). Pass `file` to `impact` to disambiguate a name defined in several places.
3. **Tests to run** — `affected` for the changed set (CLI: `git diff --name-only | mimirs affected --stdin`). Run those before claiming the change is done.
4. **Known caveats** — `get_annotations` on the touched files: fragile code, constraints, "don't refactor until X".
5. **Why it's like this** — `search_checkpoints "<area>"` (prior decisions) and `search_commits "<area>"` (why it changed before), so you don't undo a deliberate choice.
6. **After the change** — re-run `impact` / `affected`; `annotate` any new caveat you introduce; `create_checkpoint` the decision and what changed.

Finish: a risk summary — callers affected, tests to run, caveats, prior decisions — each with a `file:line` citation.
