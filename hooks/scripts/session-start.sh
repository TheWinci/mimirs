#!/bin/bash
# SessionStart hook: print project context at the start of a session.
# Outputs: git status, recent commits, search gaps, and annotations on modified files.

bunx @winci/local-rag session-context 2>/dev/null

exit 0
