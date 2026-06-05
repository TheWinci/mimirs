---
name: handoff
description: Wrap up a work session so the next session (or another agent) can pick up cleanly — what was done, what's in flight, what to watch out for. Use when ending a session, switching tasks, or asked to hand off, wrap up, or save state for later.
---

# Handoff

Goal: leave the project state recorded so the next session starts from `catch-up`, not from scratch. The end-of-session counterpart to `catch-up`.

1. **Snapshot what changed** — `git_context` for the modified/uncommitted files and recent commits, so the handoff names the exact files touched this session.
2. **Record caveats** — `annotate` any fragile spot, constraint, race, or workaround you discovered or introduced this session, on the file it lives in; `get_annotations` on the touched files to confirm earlier notes still hold (`delete_annotation` ones a fix made stale).
3. **Record the decision & next step** — `create_checkpoint` (type `handoff`) with what was done, which files changed, why, and the concrete next action. Keep the summary tight (it has a length cap). If the session was a dead end or a direction change, say so and why.

Finish: a short handoff note — done / in flight / next step / open caveats — each with a `file:line` or checkpoint reference, so a fresh session can resume without re-deriving context.
