# Generate the README demo gif:  vhs demo.tape   ->   demo.gif
#
# Prereq: STOP the mimirs MCP server first — it holds the project index lock,
# so the fresh `index` below would be blocked.
#
# Flow: index -> search -> read -> affected, each shown then cleared. The index
# is wiped and rebuilt fresh on camera; the ~65s embed wait happens off-camera
# (Hide), then the "Done: N indexed" line is revealed.

Output demo.gif
Require bun

Set Shell "bash"
Set FontSize 16
Set Width 1100
Set Height 600
Set Theme "Dracula"
Set Padding 20
Set TypingSpeed 30ms

# hidden: minimal prompt, local mimirs alias, wipe the index, swallow noise
Hide
Type `export PS1="❯ "` Enter
Type `alias mimirs="bun run /Users/winci/repos/mimirs/src/main.ts"` Enter
Type "rm -rf .mimirs" Enter
Type "clear" Enter
Show

# 1. index — point it at your project (AST-aware chunking + embeddings)
Type "mimirs index" Enter
Sleep 3s
Hide
Sleep 80s
Show
Sleep 4s
Type "clear" Enter

# 2. search — a natural question, scoped to code, returns ranked files
Type `mimirs search "reciprocal rank fusion blend" --ext .ts --top 5` Enter
Sleep 4s
Type "clear" Enter

# 3. read — the exact function, with its line range
Type `mimirs read "escapeLike LIKE metacharacter escaping" --top 2` Enter
Sleep 4s
Type "clear" Enter

# 4. affected — which tests to run for a change
Type "mimirs affected src/search/hybrid.ts" Enter
Sleep 4.5s
