---
name: research
description: Answer a hard, open-ended question about how the project works or is built by synthesizing every source — code, structure, git history, prior decisions, discussion, caveats — and verifying each claim against the source. Use for deep cross-cutting questions that span more than one area. Narrower siblings — a single area's structure is explore, the rationale behind one past decision is recall, a failure's root cause is debug.
---

# Research

Goal: a thorough, cited answer to a specific question — pulled from across the whole project memory, not one file or one area. Where `explore` maps an area's structure, `research` answers a question by combining code, history, decisions, and discussion.

1. **Frame the question** — break it into the sub-questions you must answer. State them, so the synthesis can be checked against them at the end.
2. **The code** — `search "<sub-question>"` for the relevant files, then `read_relevant "<behavior>"` for the actual functions/sections with line ranges. Use the `extensions`/`dirs`/`excludeDirs` filters to scope. `search_symbols <name>` for named things you already know.
3. **How it connects** — when the question is about relationships: `project_map(focus: <file>)`, `depends_on`/`dependents <file>`, `impact <symbol>` (transitive callers), `trace from=<a> to=<b>` (how one reaches another).
4. **History & why** — `search_commits "<topic>"` for why and when it changed; `file_history <file>` for how a file evolved.
5. **Decisions & discussion** — `search_checkpoints "<topic>"` for recorded decisions and direction changes; `search_conversation "<topic>"` for the back-and-forth and alternatives considered.
6. **Caveats** — `get_annotations` (search across notes) for known bugs, constraints, and fragile spots that qualify the answer.
7. **Verify** — before asserting any claim, reopen the cited source and confirm it. Don't synthesize from snippets alone.

Finish: answer each sub-question in plain language with a `file:line`, commit, or checkpoint citation; separate what the source proves from what is inferred; list what stayed unresolved instead of guessing.
