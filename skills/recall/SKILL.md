---
name: recall
description: Answer "why" and "when" questions about a project's decisions — the intent behind a past choice, when it was made, what was tried before and rejected. Use when asked why something was decided, what the rationale was, or before reversing or redoing earlier work. For why the code mechanically behaves a certain way use research; for why it breaks use debug.
---

# Recall

Goal: find the reasoning and history behind code, not just the code.

1. **Why it changed** — `search_commits "<topic/decision>"` for the commits that explain a change and the intent behind it; `file_history <file>` for how a specific file evolved.
2. **Decisions made** — `search_checkpoints "<topic>"` for recorded decisions, milestones, and direction changes.
3. **Discussion** — `search_conversation "<topic>"` for the back-and-forth that led to a choice, including alternatives considered.

Finish: state the decision/history with its source (commit hash, checkpoint, or session) so the answer is traceable. If the history shows a deliberate choice, surface it — don't silently undo it.
