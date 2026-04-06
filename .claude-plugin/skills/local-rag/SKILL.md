---
name: local-rag
description: >
  TRIGGER when: starting a new session, exploring unfamiliar code, searching for
  functions/types/files, planning refactors, or needing context about past decisions.
  Use local-rag MCP tools (search, read_relevant, project_map, etc.) instead of
  manually grepping or reading files when semantic understanding is needed.
user-invocable: false
---

## Using local-rag tools

This project has a local RAG index (local-rag). Use these MCP tools:

- **`search`**: Discover which files are relevant to a topic. Returns file paths
  with snippet previews — use this when you need to know *where* something is.
- **`read_relevant`**: Get the actual content of relevant semantic chunks —
  individual functions, classes, or markdown sections — ranked by relevance.
  Results include exact line ranges (`src/db.ts:42-67`) so you can navigate
  directly to the edit location. Use this instead of `search` + `Read` when
  you need the content itself. Two chunks from the same file can both appear
  (no file deduplication).
- **`project_map`**: When you need to understand how files relate to each other,
  generate a dependency graph. Use `focus` to zoom into a specific file's
  neighborhood. This is faster than reading import statements across many files.
- **`search_conversation`**: Search past conversation history to recall previous
  decisions, discussions, and tool outputs. Use this before re-investigating
  something that may have been discussed in an earlier session.
- **`create_checkpoint`**: Mark important moments — decisions, milestones,
  blockers, direction changes. Do this liberally: after completing any feature
  or task, after adding/modifying tools, after key technical decisions, before
  and after large refactors, or when changing direction. If in doubt, create one.
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
- **`annotate`**: Attach a persistent note to a file or symbol — "known race
  condition", "don't refactor until auth rewrite lands", etc. Notes appear as
  `[NOTE]` blocks inline in `read_relevant` results automatically.
- **`get_annotations`**: Retrieve all notes for a file, or search semantically
  across all annotations to find relevant caveats before editing.
- **`depends_on`**: List all files that a given file imports — its dependencies.
- **`depended_on_by`**: List all files that import a given file — reverse
  dependencies. Use before modifying a shared module to see who depends on it.
- **`write_relevant`**: Before adding new code or docs, find the best insertion
  point — returns the most semantically appropriate file and anchor.
- **`generate_wiki`**: Generate or update a structured markdown wiki for the
  codebase. Call with `run: true` to immediately execute all phases. Follow
  the returned instructions step by step using the other local-rag tools to
  build wiki pages in `wiki/`.
