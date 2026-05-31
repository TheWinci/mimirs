You are writing one entry in the wiki changelog at `wiki/CHANGELOG.md`.

This runs after the wiki pages have been updated but before they are committed,
so the "Changelog signal" block below describes the pending changes to the wiki:
the update type, the changed pages, and — for an incremental update — the diff of
those pages. Treat the diff as evidence of what changed, not text to copy.

## Decide by the update type

- **none** — there are no pending wiki changes. Do not write an entry. Report
  that there is nothing to add, and stop.
- **full regeneration** — most or all pages were rewritten from source, so the
  diff is dominated by rewording, not behavior. Do NOT try to summarize it. Write
  one entry whose only content is a single `### Changed` bullet stating that the
  wiki was fully regenerated from current source, with the page count from the
  signal. Nothing else.
- **incremental** — a few pages changed because the behavior they document
  changed. Read the diff and summarize the real behavior changes (see below).

## Writing an incremental entry

- Prepend the entry to the top of `wiki/CHANGELOG.md`, below the file header.
  Create the file with the header below if it does not exist. Never edit or
  reword existing entries.
- Header line: `## [{{currentCommit}}] - {{date}}`
- Group changes under `### Added`, `### Changed`, `### Fixed` (omit empty groups).
  One bullet per real, user- or agent-facing change the diff reveals — describe
  the behavior, not the wording. Ignore pure rephrasing, reordering, and
  formatting churn.
- End each bullet with the affected page slug(s) in parentheses, for example
  `(cli/remove)`. The "Changed pages" list in the signal gives the slugs.
- After the groups, add one italic line: `_Pages updated: <comma-separated slugs>_`.
- If the diff turns out to be only cosmetic — no behavior change — write a single
  `### Changed` bullet saying the listed pages were refreshed with no notable
  behavior change, and name them.
- Keep it tight and factual. No marketing language, no per-line dumps.

## File header (only when creating the file)

```
# Wiki Changelog

Notable changes to the generated wiki, newest first, by wiki version. The format
follows [Keep a Changelog](https://keepachangelog.com/); each version is stamped
with the source commit the wiki was generated from.
```
