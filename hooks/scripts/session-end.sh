#!/bin/bash
# SessionEnd hook: auto-create a checkpoint summarizing the session.
# Uses git diff to capture what changed during the session.

if ! command -v bun &>/dev/null; then
  exit 0  # Bun not installed — skip silently
fi

DIR="${CLAUDE_PROJECT_DIR:-${RAG_PROJECT_DIR:-.}}"

# Only run in projects that opted into mimirs (same guard as session-start.sh).
# checkpoint create constructs a database — without this guard, every Claude
# session ending with uncommitted changes in ANY repo got a surprise .mimirs/.
if [ ! -d "$DIR/.mimirs" ]; then
  exit 0
fi

# Collect changed files since session start (uncommitted changes)
CHANGED=$(git -C "$DIR" diff --name-only HEAD 2>/dev/null)
STAGED=$(git -C "$DIR" diff --name-only --cached 2>/dev/null)
UNTRACKED=$(git -C "$DIR" ls-files --others --exclude-standard 2>/dev/null)

# Count BEFORE truncating to 20, so the summary doesn't claim "20 files"
# when 100 changed.
ALL_UNIQUE=$(printf '%s\n' "$CHANGED" "$STAGED" "$UNTRACKED" | sort -u | grep -v '^$')
FILE_COUNT=$(printf '%s\n' "$ALL_UNIQUE" | grep -c . || true)
ALL_FILES=$(printf '%s\n' "$ALL_UNIQUE" | head -20 | tr '\n' ',' | sed 's/,$//')

if [ -z "$ALL_FILES" ]; then
  # Nothing changed — skip checkpoint
  exit 0
fi

SUMMARY="Session ended with ${FILE_COUNT} modified file(s): ${ALL_FILES}"

bunx mimirs checkpoint create \
  "handoff" \
  "Session end (auto)" \
  "$SUMMARY" \
  --dir "$DIR" \
  --files "$ALL_FILES" \
  --tags "auto,session-end" \
  2>/dev/null &

exit 0
