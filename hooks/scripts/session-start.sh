#!/bin/bash
# SessionStart hook: print project context at the start of a session.
# Outputs: git status, recent commits, search gaps, and annotations on modified files.

if ! command -v bun &>/dev/null; then
  echo "[local-rag] Bun is required but not installed. Install it: https://bun.sh" >&2
  exit 0
fi

# Only run in projects that have a local-rag index
if [ ! -d ".rag" ] && [ ! -d "${RAG_PROJECT_DIR:-.}/.rag" ]; then
  exit 0
fi

bunx @winci/local-rag session-context 2>/dev/null

exit 0
