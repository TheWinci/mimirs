---
name: explore
description: Build an accurate mental model of an unfamiliar codebase, feature, or area before changing it — where it lives, how it connects, what it does, and why. Use when asked how something works, where something is, when onboarding to a repo, or before editing code you don't know. For a cross-cutting question that needs answering from many sources, use research instead.
---

# Explore

Goal: understand the area from real source before touching it. Prefer the mimirs tools over `grep` + reading whole files.

1. **Where is it** — `search "<topic>"` for ranked files, then `read_relevant "<topic>"` to pull the actual functions/sections with line ranges (not just paths). Two chunks from one file can both appear.
2. **How it connects** — `project_map(focus: <key file>)` for its neighborhood; `dependents <file>` for who relies on it; `depends_on <file>` for what it pulls in.
3. **Read the core** — `read_relevant "<specific behavior>"` on the key files; follow the helper calls a named file delegates to.
4. **History & why** — `git_context` for what changed recently; `file_history <file>` for how a file evolved; `search_commits "<topic>"` for why past decisions were made.
5. **Prior context** — `search_conversation "<topic>"` and `search_checkpoints "<topic>"` for earlier discussion and decisions, so you don't re-derive what's already known.
6. **Caveats** — `get_annotations` on the key files for known bugs, fragile spots, or constraints before trusting the code.

Finish: summarize in plain language — entry points, key files, data flow, gotchas — each with a `file:line` citation. Flag anything still unclear instead of guessing.
