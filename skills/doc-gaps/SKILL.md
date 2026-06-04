---
name: doc-gaps
description: Find what's underdocumented or hard to retrieve in a project — the topics people search for but don't find. Use when improving docs or the wiki, or when asked what's missing or poorly covered.
---

# Doc-gaps

Goal: surface where the index (and likely the docs) fail to answer real queries.

1. **Find the gaps** — `search_analytics` for queries that returned no results or only low-relevance hits; these are topics people look for but the codebase/docs don't surface well.
2. **Confirm each gap** — run `search` / `read_relevant` on the weak query yourself: is the content genuinely missing, or just poorly named / undocumented?
3. **Find where to add** — `write_relevant "<topic>"` for the best insertion point for new docs or a doc-comment.

Finish: a prioritized list — the query, whether content is missing vs. undiscoverable, and the suggested place to document it (`file:line`).
