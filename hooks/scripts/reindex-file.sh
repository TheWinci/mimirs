#!/bin/bash
# PostToolUse hook: re-index files modified by Write/Edit tools.
# Claude Code passes hook event JSON on stdin.
# The tool_input contains the file_path of the modified file.

if ! command -v bun &>/dev/null; then
  exit 0  # Bun not installed — skip silently, server startup will surface the error
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only re-index if the file exists (not a deletion)
if [ -f "$FILE_PATH" ]; then
  # Fire and forget — don't block the agent
  bunx @winci/local-rag index "$(dirname "$FILE_PATH")" --file "$FILE_PATH" 2>/dev/null &
fi

exit 0
