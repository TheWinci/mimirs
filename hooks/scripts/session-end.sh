#!/bin/bash
# SessionEnd hook: auto-create a checkpoint summarizing the session.
# Uses git diff to capture what changed during the session.

DIR="${RAG_PROJECT_DIR:-.}"

# Collect changed files since session start (uncommitted changes)
CHANGED=$(git -C "$DIR" diff --name-only HEAD 2>/dev/null)
STAGED=$(git -C "$DIR" diff --name-only --cached 2>/dev/null)
UNTRACKED=$(git -C "$DIR" ls-files --others --exclude-standard 2>/dev/null)

# Merge all changed files into a comma-separated list
ALL_FILES=$(printf '%s\n' "$CHANGED" "$STAGED" "$UNTRACKED" | sort -u | grep -v '^$' | head -20 | tr '\n' ',' | sed 's/,$//')

if [ -z "$ALL_FILES" ]; then
  # Nothing changed — skip checkpoint
  exit 0
fi

FILE_COUNT=$(echo "$ALL_FILES" | tr ',' '\n' | wc -l | tr -d ' ')
SUMMARY="Session ended with ${FILE_COUNT} modified file(s): ${ALL_FILES}"

bunx @winci/local-rag checkpoint create \
  "handoff" \
  "Session end (auto)" \
  "$SUMMARY" \
  --dir "$DIR" \
  --files "$ALL_FILES" \
  --tags "auto,session-end" \
  2>/dev/null &

exit 0
