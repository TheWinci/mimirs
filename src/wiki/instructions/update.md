You are deciding which wiki pages to regenerate after the project changed, so the
wiki can be updated without a full rebuild.

Below is an "Update signal": the source and instruction changes since the wiki was
last generated (the "Cause diff"), and the current wiki page index (slug — title).
The wiki pages themselves are not in the diff — only their causes.

## Decide which pages are stale

Read the cause diff and, using the page index to name them, decide which pages each
change affects:

- A change to **code** affects the page(s) that document that code's flow — usually
  one or a few specific pages.
- A change to a wiki **instruction** file (`.../instructions/page-*.md`, or a
  project's `.mimirs/wiki/page-*.md`) affects a whole page **kind**: a flow-page
  instruction change touches every flow page (commands, tools, routes, messages,
  jobs, server-start); an overview-instruction change touches the overview pages.
- A change to `discovery.md` or `write.md` changes how discovery or page-splitting
  works — that is a full rebuild, not a page update.
- When unsure whether a change affects a page, include it. A needless regeneration
  is cheaper than leaving a page stale.

If the signal says **too much changed**, do not attempt a targeted update — run the
full wiki rebuild instead (`shape` → discovery → write all pages).

## Regenerate the affected pages

For each affected page slug, call `wiki(write:page:<slug>)` and rewrite
`wiki/<slug>.md` from current source by following that prompt. Do not touch pages
that no change affects — leaving them untouched is the point of an update.

When the affected pages are written:

1. Call `wiki(validate-pages)` and fix any broken links.
2. Call `wiki(changelog)` to record what changed in the wiki.
3. Commit the regenerated pages and the changelog together.

Report which pages you regenerated and the change that made each one stale.
