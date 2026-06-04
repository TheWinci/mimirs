---
name: catch-up
description: Get oriented on a project's current state when starting or resuming work — what's changed, what's in flight, and the recent decisions. Use at the start of a session, when returning to a repo after a break, or when asked "where were we" or "what's the status".
---

# Catch-up

Goal: rebuild context on the *current state* — not the whole codebase (that's `explore`).

1. **What's changed** — `git_context` for modified/uncommitted files, recent commits, and which changed files are in the index.
2. **Recent decisions** — `list_checkpoints` for the latest checkpoints; `search_checkpoints "<area you're resuming>"` for ones relevant to the task.
3. **Open caveats** — `get_annotations` on the changed files for known bugs, constraints, or "don't touch until X" notes left earlier.
4. **Prior discussion** — `search_conversation "<task/area>"` to recall what was being worked on and any unresolved threads.

Finish: a short status — what changed, what's in flight, decisions/caveats affecting the next step — with `file:line` and checkpoint references. Confirm the plan before continuing.
