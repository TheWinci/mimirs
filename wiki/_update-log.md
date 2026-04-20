# Wiki Update Log

Append-only log of wiki generation and incremental updates. Newest entries at the bottom. Emitted deterministically from the staleness report — not LLM-generated.

## 2026-04-19 06:30 UTC — Full initialization (`faaf91f`)

28 pages generated (6 aggregate, 22 module).

## 2026-04-20 13:03 UTC — Incremental update (`faaf91f` → `f57bdf2`)

51 files changed. 13 regenerated, 0 added, 0 removed.

### Regenerated

- `wiki/modules/db/index.md` — db (module, full)
  - trigger: `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`
- `wiki/modules/graph.md` — graph (module, brief)
  - trigger: `src/graph/resolver.ts`
- `wiki/modules/cli.md` — cli (module, brief)
  - trigger: `src/cli/index.ts`
- `wiki/modules/commands.md` — commands (module, standard)
  - trigger: `src/cli/commands/demo.ts`, `src/cli/commands/map.ts`
- `wiki/modules/tools.md` — tools (module, standard)
  - trigger: `src/tools/graph-tools.ts`, `src/tools/wiki-tools.ts`
- `wiki/modules/wiki/index.md` — wiki (module, full)
  - trigger: `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`
- `wiki/modules/wiki/discovery.md` — discovery (module-file, standard)
  - trigger: `src/wiki/discovery.ts`
- `wiki/architecture.md` — Architecture (architecture, standard)
  - trigger: `.claude-plugin/skills/mimirs/SKILL.md`, `.claude-plugin/skills/wiki/SKILL.md`, `README.md`, `docs/examples.md`, `docs/tools.md`, `src/graph/resolver.ts`, `wiki/_update-log.md`, `wiki/architecture.md`, `wiki/data-flows.md`, `wiki/guides/conventions.md`, `wiki/guides/getting-started.md`, `wiki/guides/testing.md`, `wiki/index.md`, `wiki/modules/cli.md`, `wiki/modules/commands.md`, `wiki/modules/config.md`, `wiki/modules/conversation.md`, `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`, `wiki/modules/embeddings.md`, `wiki/modules/graph.md`, `wiki/modules/indexing.md`, `wiki/modules/search.md`, `wiki/modules/tests.md`, `wiki/modules/tools.md`, `wiki/modules/utils.md`, `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`
- `wiki/data-flows.md` — Data Flows (data-flows, standard)
  - trigger: `.claude-plugin/skills/mimirs/SKILL.md`, `.claude-plugin/skills/wiki/SKILL.md`, `README.md`, `docs/examples.md`, `docs/tools.md`, `src/graph/resolver.ts`, `wiki/_update-log.md`, `wiki/architecture.md`, `wiki/data-flows.md`, `wiki/guides/conventions.md`, `wiki/guides/getting-started.md`, `wiki/guides/testing.md`, `wiki/index.md`, `wiki/modules/cli.md`, `wiki/modules/commands.md`, `wiki/modules/config.md`, `wiki/modules/conversation.md`, `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`, `wiki/modules/embeddings.md`, `wiki/modules/graph.md`, `wiki/modules/indexing.md`, `wiki/modules/search.md`, `wiki/modules/tests.md`, `wiki/modules/tools.md`, `wiki/modules/utils.md`, `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`
- `wiki/guides/getting-started.md` — Getting Started (getting-started, standard)
  - trigger: `.claude-plugin/skills/mimirs/SKILL.md`, `.claude-plugin/skills/wiki/SKILL.md`, `README.md`, `docs/examples.md`, `docs/tools.md`, `src/graph/resolver.ts`, `wiki/_update-log.md`, `wiki/architecture.md`, `wiki/data-flows.md`, `wiki/guides/conventions.md`, `wiki/guides/getting-started.md`, `wiki/guides/testing.md`, `wiki/index.md`, `wiki/modules/cli.md`, `wiki/modules/commands.md`, `wiki/modules/config.md`, `wiki/modules/conversation.md`, `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`, `wiki/modules/embeddings.md`, `wiki/modules/graph.md`, `wiki/modules/indexing.md`, `wiki/modules/search.md`, `wiki/modules/tests.md`, `wiki/modules/tools.md`, `wiki/modules/utils.md`, `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`
- `wiki/guides/conventions.md` — Conventions (conventions, standard)
  - trigger: `.claude-plugin/skills/mimirs/SKILL.md`, `.claude-plugin/skills/wiki/SKILL.md`, `README.md`, `docs/examples.md`, `docs/tools.md`, `src/graph/resolver.ts`, `wiki/_update-log.md`, `wiki/architecture.md`, `wiki/data-flows.md`, `wiki/guides/conventions.md`, `wiki/guides/getting-started.md`, `wiki/guides/testing.md`, `wiki/index.md`, `wiki/modules/cli.md`, `wiki/modules/commands.md`, `wiki/modules/config.md`, `wiki/modules/conversation.md`, `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`, `wiki/modules/embeddings.md`, `wiki/modules/graph.md`, `wiki/modules/indexing.md`, `wiki/modules/search.md`, `wiki/modules/tests.md`, `wiki/modules/tools.md`, `wiki/modules/utils.md`, `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`
- `wiki/guides/testing.md` — Testing (testing, standard)
  - trigger: `.claude-plugin/skills/mimirs/SKILL.md`, `.claude-plugin/skills/wiki/SKILL.md`, `README.md`, `docs/examples.md`, `docs/tools.md`, `src/graph/resolver.ts`, `wiki/_update-log.md`, `wiki/architecture.md`, `wiki/data-flows.md`, `wiki/guides/conventions.md`, `wiki/guides/getting-started.md`, `wiki/guides/testing.md`, `wiki/index.md`, `wiki/modules/cli.md`, `wiki/modules/commands.md`, `wiki/modules/config.md`, `wiki/modules/conversation.md`, `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`, `wiki/modules/embeddings.md`, `wiki/modules/graph.md`, `wiki/modules/indexing.md`, `wiki/modules/search.md`, `wiki/modules/tests.md`, `wiki/modules/tools.md`, `wiki/modules/utils.md`, `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`
- `wiki/index.md` — Index (index, standard)
  - trigger: `.claude-plugin/skills/mimirs/SKILL.md`, `.claude-plugin/skills/wiki/SKILL.md`, `README.md`, `docs/examples.md`, `docs/tools.md`, `src/graph/resolver.ts`, `wiki/_update-log.md`, `wiki/architecture.md`, `wiki/data-flows.md`, `wiki/guides/conventions.md`, `wiki/guides/getting-started.md`, `wiki/guides/testing.md`, `wiki/index.md`, `wiki/modules/cli.md`, `wiki/modules/commands.md`, `wiki/modules/config.md`, `wiki/modules/conversation.md`, `wiki/modules/db/conversation.md`, `wiki/modules/db/files.md`, `wiki/modules/db/git-history.md`, `wiki/modules/db/graph.md`, `wiki/modules/db/index.md`, `wiki/modules/db/types.md`, `wiki/modules/embeddings.md`, `wiki/modules/graph.md`, `wiki/modules/indexing.md`, `wiki/modules/search.md`, `wiki/modules/tests.md`, `wiki/modules/tools.md`, `wiki/modules/utils.md`, `wiki/modules/wiki/discovery.md`, `wiki/modules/wiki/index.md`, `wiki/modules/wiki/section-selector.md`, `wiki/modules/wiki/staleness.md`, `wiki/modules/wiki/types.md`

### Narrative

- `wiki/modules/graph.md`: removed `maxNodes` from `GraphOptions`; `generateProjectMap` no longer auto-switches to directory view — callers get exactly the `zoom` they request.
- `wiki/modules/commands.md`: dropped `--max N` from the `map` subcommand and rewrote the `demo` entry around the new four-step `index → search → read_relevant → search_symbols` walkthrough with `renderBlock`-trimmed snippet previews.
- `wiki/modules/tools.md`: `project_map` MCP schema no longer accepts `maxNodes`; incremental `generate_wiki` responses now append `INDEX_FRESHNESS_NOTE` telling the agent to re-run `index_files()` if stale results persist.
- `wiki/modules/wiki/discovery.md`: removed the `computeMaxNodes` node-cap section — discovery now calls `generateProjectMap` without any cap on both the file-level and directory-level graphs.
- `wiki/modules/wiki/index.md`: updated Phase 1 summary and the `discovery.ts` per-file entry to drop the `computeMaxNodes` heuristic.
- `wiki/guides/getting-started.md`: re-described `mimirs demo` as the four-step walkthrough rather than a sample-project index run.
