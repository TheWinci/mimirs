---
name: mimirs
description: >
  TRIGGER when: starting a new session, exploring unfamiliar code, searching for
  functions/types/files, planning refactors, assessing blast radius, reviewing a
  diff, or needing context about past decisions. Use mimirs MCP tools instead of
  manually grepping or reading files when semantic understanding is needed.
user-invocable: false
---

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
  something that may have been discussed in an earlier session.
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
- **`find_usages`**: Before changing a function or type, find all its call sites.
  Use this to understand the blast radius of a rename or API change. Faster and
  more reliable than semantic search for finding usages.
- **`git_context`**: At the start of a session (or any time you need orientation),
  call this to see what files have already been modified, recent commits, and
  which changed files are in the index. Avoids redundant searches and conflicting
  edits on already-modified files.
- **`search_commits`**: Semantically search git commit history — find *why* code
  was changed, when decisions were made, or what an author worked on. Supports
  filters for author, date range, and file path. Requires git history to be
  indexed first (`index_files` or `mimirs history index`).
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
- **`depended_on_by`**: List all files that import a given file — reverse
  dependencies. Use before modifying a shared module to see who depends on it.
- **`impact_analysis`**: Before refactoring, renaming, or changing a function
  signature, run this on the symbol or file to see direct callers, importers,
  transitive dependents, annotations, git co-change, and test coverage — with
  a 0–100 risk score explaining *why* the change is risky.
- **`diff_context`**: PR-review helper. For the working tree (or
  `staged: true`), reports each changed file's touched symbols, callers of
  those symbols, linked tests, annotations, and related checkpoints. Use
  before self-reviewing your diff or reviewing a teammate's branch.
- **`write_relevant`**: Before adding new code or docs, find the best insertion
  point — returns the most semantically appropriate file and anchor.
- **`generate_wiki`**: Generate or update a structured markdown wiki for the
  codebase. Call with `run: true` to immediately execute all phases. Follow
  the returned instructions step by step using the other mimirs tools to
  build wiki pages in `wiki/`.
