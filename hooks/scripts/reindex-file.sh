#!/bin/bash
# PostToolUse hook: re-index files modified by Write/Edit tools.
# Claude Code passes hook event JSON on stdin.
# The tool_input contains the file_path of the modified file.

if ! command -v bun &>/dev/null; then
  exit 0  # Bun not installed — skip silently, server startup will surface the error
fi

# Only run in projects that opted into mimirs (same guard as session-start.sh).
# Without this the hook fired in EVERY repo on every Write/Edit, loading the
# embedding model and creating surprise databases.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
if [ ! -d "$PROJECT_DIR/.mimirs" ]; then
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only re-index if the file exists (not a deletion)
if [ -f "$FILE_PATH" ]; then
  # Fire and forget — don't block the agent. This is a fallback for running
  # without the MCP server; when the server is up its file watcher is the real
  # reindex path and this lock-aware incremental pass is a no-op.
  #
  # Index the PROJECT root, never dirname of the file: `mimirs index <dir>`
  # treats its argument as a project root, so dirname created a fresh .mimirs/
  # database inside whatever subdirectory was edited (and with RAG_DB_DIR set,
  # a subtree scan's prune pass could wipe the shared index).
  bunx mimirs index "$PROJECT_DIR" 2>/dev/null &
fi

exit 0
