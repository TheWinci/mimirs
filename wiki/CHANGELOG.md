# Wiki Changelog

Notable changes to the generated wiki, newest first, by wiki version. The format
follows [Keep a Changelog](https://keepachangelog.com/); each version is stamped
with the source commit the wiki was generated from.

## [094fb87] - 2026-06-02

### Changed
- Regenerated all 53 pages from current source (45 changed). The search internals were corrected throughout: vector and BM25 results are now fused by reciprocal-rank fusion (`rrfFuse`), replacing the obsolete linear blend; the default `hybridWeight` is 0.5; and identifier-aware full-text search (the `parts` column with camelCase/snake_case splitting) is documented across the search, data-model, and overview pages. The configuration page gains `embeddingPooling` / `embeddingDtype`. Git-history search (search_commits, cli/history) keeps its fixed 0.7 blend. Drifted source citations were corrected.

_Pages updated: all 53 pages_

## [8b52efc] - 2026-06-01

### Added
- New page documenting cli/affected
- New page documenting tools/impact
- New page documenting tools/trace
- New page documenting tools/usages
- New page documenting tools/dependents

### Removed
- tools/find-usages
- tools/depended-on-by

### Changed
- Regenerated all 53 pages from current source. The `find_usages` → `usages` and `depended_on_by` → `dependents` tool rename was propagated throughout, and drifted source citations were corrected.

_Pages updated: all 53 pages_

## [5c7b45b] - 2026-05-31

### Changed
- Regenerated all 50 pages from current source.

_Pages updated: all 50 pages_

## [b85ca02] - 2026-05-31

### Added
- The wiki tool page now documents the `update` command: an incremental refresh
  that resolves the commit the wiki was last generated from and returns the
  source and instruction changes since then, plus the page index, so a caller
  rewrites only the pages a change made stale instead of regenerating everything
  (tools/wiki).

### Changed
- The wiki tool page's `changelog` section now describes effect-based, per-page
  churn classification — surgical edits summarized from their diffs, wholesale
  rewrites listed only, and new or removed pages — and corrects the ejected
  instruction list to ten files, adding `update.md` (tools/wiki).

_Pages updated: tools/wiki_

## [b37b514] - 2026-05-31

### Added
- The wiki tool page now documents the `changelog` command and corrects the
  ejected-instruction list to nine files; the page predated both (tools/wiki).

### Changed
- Flow-page diagrams now match the shape of each flow instead of always using a
  sequence diagram: flowcharts for branching dispatch and pipelines — the wiki
  command router, the search rerank pipeline, and the server-start decision tree
  — while linear request/response flows keep a sequence diagram (server/start,
  tools/search, tools/wiki).

_Pages updated: server/start, tools/index-status, tools/search, tools/wiki_

## [e5d2055] - 2026-05-31

### Added
- Wiki generation prose is now editable per project: the discovery, page-writing,
  and shared-block instructions live in markdown and can be copied into
  `.mimirs/wiki/` with `wiki(eject)`, where a project file overrides the packaged
  default (tools/wiki).
- Conversation indexing now watches the whole project session folder — it
  backfills every past session and tails the live one and any that start later,
  so findings are searchable across sessions in near real time. Previously only
  the single current transcript was tailed (cli/conversation, server/start,
  runtime-lifecycle).

### Changed
- The configured embedding dimension is applied before the database schema is
  created, so a custom model's vector tables are sized correctly; a mismatch now
  fails with a clear error instead of silently breaking (data-model,
  tools/index-files).
- Removing a file no longer leaves orphaned graph rows, and an after-delete
  trigger keeps the vector table in sync with the chunk table — foreign-key
  cascades are off, so both are done explicitly (cli/remove, tools/remove-file,
  data-model).
- Result grouping honors the `parentGroupingMinCount` setting when promoting a
  shared parent chunk over its children (cli/read, cli/search, tools/read-relevant,
  tools/search).
- `server_info` reports the `.mimirs` data directory; it previously named the old
  `.rag` directory (tools/server-info).
- Numeric CLI flags are validated and report a usage error instead of crashing
  with a range error (cli/benchmark, cli/eval, cli/search).

### Fixed
- `mimirs remove <file> [dir]` resolves `<file>` against the target directory
  rather than the current working directory, fixing a false "not in the index"
  result when the two differ (cli/remove).
- The `mimirs map` help text no longer claims Mermaid output; the command emits
  structured text (cli/map).
- `find_usages` logs full-text-search errors instead of swallowing them
  (tools/find-usages).

_Pages updated: cli/benchmark, cli/conversation, cli/eval, cli/map, cli/read, cli/remove, cli/search, data-model, runtime-lifecycle, server/start, tools/find-usages, tools/index-files, tools/read-relevant, tools/remove-file, tools/search, tools/server-info, tools/wiki_
