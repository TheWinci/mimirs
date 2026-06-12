use simple language

<!-- mimirs:start v=5e2424a -->
## Using mimirs tools

This project has a local RAG index (mimirs). Use these MCP tools:

- **`search`**: Discover which files are relevant to a topic. Returns file paths
  with snippet previews — use this when you need to know *where* something is.
  Supports optional `extensions`, `dirs`, and `excludeDirs` filters to scope
  results (e.g. restrict to `.ts` files, or under `src/`).
- **`read_relevant`**: Get the actual content of relevant semantic chunks —
  individual functions, classes, or markdown sections — ranked by relevance.
  Results include exact line ranges (`src/db.ts:42-67`) so you can navigate
  directly to the edit location. Use this instead of `search` + `Read` when
  you need the content itself. Two chunks from the same file can both appear
  (no file deduplication). Accepts the same `extensions`/`dirs`/`excludeDirs`
  filters as `search`.
- **`project_map`**: When you need to understand how files relate to each other,
  generate a dependency graph. Use `focus` to zoom into a specific file's
  neighborhood. This is faster than reading import statements across many files.
- **`search_conversation`**: Search past conversation history to recall previous
  decisions, discussions, and tool outputs. Use this before re-investigating
  something that may have been discussed in an earlier session. Returns short
  snippets — follow up with `read_conversation` to get the full text.
- **`read_conversation`**: Read the full verbatim text of past turns by
  `sessionId` + turn index (or a `from`/`to` range, or `turn` + `context`). The
  read counterpart to `search_conversation`: it locates the turn, this hydrates
  it. Pass `includeToolOutput: true` to also get tool results (re-parses the raw
  transcript; slower). Defaults to the most recent session's tail when given no
  selector.
- **`create_checkpoint`**: **Call this as your final step after completing any
  user-requested task**, before responding to the user. Also call when hitting
  a blocker or changing direction mid-task. Include what was done, which files
  changed, and why. This is the only way future sessions know what happened.
- **`list_checkpoints`** / **`search_checkpoints`**: Review or search past
  checkpoints to understand project history and prior decisions.
- **`index_files`**: If you've created or modified files and want them searchable,
  re-index the project directory.
- **`search_analytics`**: Check what queries return no results or low-relevance
  results — this reveals documentation gaps.
- **`search_symbols`**: When you know a symbol name (function, class, type, etc.),
  find it directly by name instead of using semantic search.
- **`usages`**: Before changing a function or type, find all its call sites.
  Use this to understand the blast radius of a rename or API change. Faster and
  more reliable than semantic search for finding usages.
- **`git_context`**: At the start of a session (or any time you need orientation),
  call this to see what files have already been modified, recent commits, and
  which changed files are in the index. Avoids redundant searches and conflicting
  edits on already-modified files.
- **`search_commits`**: Semantically search git commit history — find *why* code
  was changed, when decisions were made, or what an author worked on. Supports
  filters for author, date range, and file path. Requires git history to be
  indexed first (`mimirs history index` or `mimirs index git`).
- **`file_history`**: Get the commit history for a specific file. Returns commits
  that touched it, sorted by date. Use this to understand how a file evolved.
- **`annotate`**: Call this immediately when you encounter a known bug, race
  condition, fragile code, non-obvious constraint, or workaround while reading
  code. Notes persist across sessions and surface as `[NOTE]` blocks inline in
  `read_relevant` results automatically.
- **`get_annotations`**: Retrieve all notes for a file, or search semantically
  across all annotations to find relevant caveats before editing.
- **`delete_annotation`**: Remove an annotation that is no longer relevant — a
  fixed bug, a lifted constraint, or a note on deleted code. Use
  `get_annotations` first to find the ID.
- **`depends_on`**: List all files that a given file imports — its dependencies.
- **`dependents`**: List all files that import a given file — reverse
  dependencies. Use before modifying a shared module to see who depends on it.
- **`impact`**: Symbol-level blast radius — the transitive *callers* of a
  function or method as a pruned call tree, plus the test files to run. More
  precise than `dependents` (file-level). Use before changing a signature or
  behavior. Pass `file` to disambiguate a name defined in several places.
- **`trace`**: Show how one symbol reaches another — the reachable call
  sub-graph from `from` to `to`, shortest path highlighted ("how does X reach
  Y"). Resolution is static, so a dynamic-dispatch hop (callback, interface→impl,
  DI) can break the chain — it says so when it does.
- **Assessing blast radius / reviewing a diff**: for a single function or
  method, `impact` returns the transitive caller tree + tests to run in one call,
  and `trace` shows how two symbols connect. Widen with `dependents`
  (file-level importers) and `get_annotations` (known caveats) when a change
  spans a whole module. For diff or PR review, pair `git_context` (what changed)
  with `impact`/`usages` on the changed symbols and `search_checkpoints` for
  prior decisions.
- **`write_relevant`**: Before adding new code or docs, find the best insertion
  point — returns the most semantically appropriate file and anchor.
- **`wiki`**: Rebuild the project wiki. Start with `wiki(command: "shape")` and
  follow the prompts it returns — each step names the next.
<!-- mimirs:end -->
