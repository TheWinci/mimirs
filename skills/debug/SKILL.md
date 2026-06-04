---
name: debug
description: Trace a bug, error, or regression to its root cause. Use when investigating a failure, a stack trace, unexpected behavior, or "why does X happen".
---

# Debug

Goal: find the cause, not just the symptom.

1. **Locate the symptom** — `search "<error text / behavior>"`; if you have a name, `search_symbols <name>` (exact lookup). `read_relevant` the suspect code.
2. **Follow the path** — `trace from:<entrypoint> to:<suspect>` to see how execution reaches the failure (shortest path is highlighted; a dynamic-dispatch hop ends a chain and is reported as such). `usages <symbol>` for who calls the suspect.
3. **Known issues** — `get_annotations` (search across notes) — the bug may already be flagged as a caveat.
4. **When introduced** — `file_history <file>` and `search_commits "<symptom/area>"` to find the change that likely caused it; `git_context` for recent uncommitted edits.
5. **Past attempts** — `search_conversation "<symptom>"` — was this hit or discussed before?
6. **Fix & record** — once fixed, `annotate` the root cause on the file and `create_checkpoint` what was wrong and how it was resolved.

Finish: state the root cause (`file:line`), the path from trigger to failure, and the fix.
