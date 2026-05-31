You are writing one entry in the wiki changelog at `wiki/CHANGELOG.md`.

This runs after the wiki pages have been updated but before they are committed.
It records what changed in the **generated wiki** — this is the wiki's own
changelog, not a copy of the project's source changelog. Work only from the
"Changelog signal" block below; never describe source changes.

## What the signal gives you

- **Surgical edits** — pages with a small, targeted change, i.e. a real behavior
  change worth describing. Their diffs are included below the signal.
- **Refreshed wholesale** — pages rewritten end to end (reword, restructure,
  diagram swap). Their content is NOT included; do not try to summarize it.
- **New pages** / **Removed pages** — pages added or deleted this update.

## Decide what to write

- **Nothing pending** (every category empty) → do not write an entry. Report that
  there is nothing to add, and stop.
- Otherwise prepend one entry to the top of `wiki/CHANGELOG.md`, below the file
  header (create the file with the header below if it does not exist). Never edit
  existing entries. Header line: `## [{{currentCommit}}] - {{date}}`.

Build the entry from these parts, omitting any that do not apply:

- **Surgical edits** → read their diffs and write `### Added` / `### Changed` /
  `### Fixed` bullets describing the real behavior change each reveals — the
  behavior, not the wording. End each bullet with the affected page slug(s), for
  example `(cli/remove)`.
- **New pages** → under `### Added`, one bullet each: `New page documenting <slug>`.
- **Removed pages** → under `### Removed`, one bullet each: `<slug>`.
- **Refreshed wholesale** → a single `### Changed` bullet that lists them:
  `Refreshed from current source with no notable behavior change: <slugs>`. Do not
  invent behavior changes for these — you do not have their diffs.

If the only changes are wholesale refreshes (no surgical edits, no new or removed
pages), write just that one refreshed line — that is the terse full- or
partial-regeneration entry.

Close with one italic line naming every changed page:
`_Pages updated: <comma-separated slugs>_`.

Keep it tight and factual. No marketing language.

## File header (only when creating the file)

```
# Wiki Changelog

Notable changes to the generated wiki, newest first, by wiki version. The format
follows [Keep a Changelog](https://keepachangelog.com/); each version is stamped
with the source commit the wiki was generated from.
```
