# src/wiki/update-log.ts

> [Architecture](../../architecture.md) › [Wiki orchestration](../wiki-orchestration.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/wiki/update-log.ts` owns the changelog file `_update-log.md` at the wiki root and the matching pre-regen snapshot JSON under `wiki/_meta/`. It writes the four entry shapes the orchestration pipeline emits — full-init, incremental queued, incremental fallback, and the post-writer narrative — in a way that keeps the file changelog-style (newest entry directly under the header) and that lets a phase-2 LLM-produced narrative slot under the matching phase-1 stub via an HTML comment marker. The only project dependency is `src/wiki/types.ts` (for `PageManifest` and `PreRegenSnapshot`); the only consumers are `src/tools/wiki-tools.ts` (which calls every export from the wiki-tool surface) and the corresponding test file.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `SNAPSHOT_FILENAME` | variable | `export const SNAPSHOT_FILENAME = "_pre-regen-snapshot.json";` | The literal filename used under `wiki/_meta/` to store the pre-regen snapshot. Re-exported so callers can refer to it without hard-coding the string. |
| `CommitEntry` | interface | `{ hash: string; message: string }` | A minimal commit record used wherever the log needs to summarise a regen window. |
| `appendInitLog` | function | `(wikiDir, gitRef, manifest): void` | Records a full initialisation entry with a stable ISO timestamp, the git ref, the total page count, and a comma-joined per-kind breakdown derived from `manifest.pages`. |
| `appendQueueStub` | function | `(wikiDir, sinceRef, newRef, changedFileCount, staleCount, addedCount, removedCount, commitCount): void` | Phase-1 stub for an incremental regen. Emits the queued-entry header with the `<!-- regen:<newRef> -->` comment marker so a later narrative call can find it; appends a pending sentinel line unless nothing was invalidated. |
| `appendFallbackLog` | function | `(wikiDir, sinceRef, newRef, dirty, total, commitCount): void` | Variant of the queue stub used when more than half the pages would be regenerated and the orchestrator falls back to a forced full regen. Distinct heading text so readers don't confuse a fallback for a fresh init. |
| `appendNarrative` | function | `(wikiDir, newRef, narrative): { mode: "inserted" \| "appended" }` | Phase-2 append. Locates the matching `<!-- regen:<newRef> -->` marker, scopes to the stub block (marker → next `## ` heading or EOF), strips the pending sentinel, and slots the `### What changed in this regen` block at the end of the stub. Returns `"appended"` with a recovery header when the marker is missing. |
| `migrateHeader` | function | `(raw: string): string` | Idempotent rewrite that swaps the legacy "newest entries at the bottom" preamble for the current changelog-style header. The current header passes through unchanged; non-matching files are untouched. Called on every append so the convention stays truthful. |
| `snapshotPath` | function | `(wikiDir: string): string` | Resolves the absolute path to `<wikiDir>/_meta/<SNAPSHOT_FILENAME>`. The single source of truth for the snapshot location. |
| `writeSnapshot` | function | `(wikiDir: string, snap: PreRegenSnapshot): void` | Atomic write via `<path>.tmp` + `renameSync`; cleans up the tmp file and rethrows on rename failure. Creates the parent directory on demand. |
| `readSnapshot` | function | `(wikiDir: string): PreRegenSnapshot \| null` | Returns `null` when the file is missing, malformed, or its `version !== 1`. Never throws — version-skew tolerance is the load-bearing property. |
| `deleteSnapshot` | function | `(wikiDir: string): void` | Removes the snapshot if present, ignoring unlink failure. Called after a successful regen to keep the next run clean. |

## Internals

- **The file is opinionated about ordering.** The internal `append` helper inserts every new entry directly after the header so the file reads changelog-style (newest first). Older entries that pre-date this convention stay in their original positions below — no rewrite. The "header" is everything up to the first `\n## ` heading; if none exists, the entry is appended at the bottom. The separator-handling code path (`headSep`, `blockSep`) preserves exactly one blank line between the header and the new entry, and one between the new entry and the previous head, so writes are idempotent across re-runs. Declared in the file's private `append` function around the middle of the module.

- **Phase-1 / phase-2 coordination is the comment marker.** `appendQueueStub` (and `appendFallbackLog`) emits `<!-- regen:<newRef> -->` directly under the entry heading. `appendNarrative` looks the same string up via `prior.indexOf(marker)` to find where to slot the narrative; markdown renderers ignore HTML comments, so the marker is invisible to readers but durable for the tool. When the marker is absent (race, manual edit, malformed log), `appendNarrative` falls back to a standalone "orphan" entry with a recovery header so the narrative is never silently lost.

- **`PENDING_SENTINEL_RE` is a precise newline-bounded regex.** The pattern matches the literal `_Per-page narrative pending writer run + \`wiki_finalize_log\`._` line, including its surrounding newlines. `appendNarrative` strips it from the stub block before injecting the narrative — that way the stub doesn't end up with a stale "pending" line under the populated narrative. Because the regex anchors on newlines, a sentence that happens to contain the same text inside a paragraph would not be touched.

- **`writeSnapshot` writes-then-renames atomically.** The function writes to `<path>.tmp` first, then `renameSync` swaps it into place. On any failure between write and rename, the catch block tries to unlink the temp file (silently ignoring its own failure) and rethrows the rename error so the caller knows the write did not land. The pattern is the standard avoid-half-written-JSON dance — a reader that opens the snapshot mid-write will always see either the previous version or the new one, never a truncated mix.

- **`readSnapshot` is total — it never throws.** Missing file, JSON parse error, and version mismatch (`parsed.version !== 1`) all collapse to `null`. The caller (`buildIncrementalResponse` in `src/tools/wiki-tools.ts`) treats `null` as "no snapshot — treat this as a fresh run", which is the correct behaviour: a corrupted or stale snapshot is no different from a missing one. Bumping `version` is how the file forces a no-op-on-old-snapshots upgrade path.

- **`migrateHeader` only rewrites the legacy preamble.** It checks for the literal `# Wiki Update Log` start AND one of two legacy phrases (`Newest entries at the bottom` or `Append-only log of wiki generation`); without both signals, the function returns the input unchanged. This is what makes calling `migrateHeader` on every `append` safe — files written under the current header pass through with no extra work, and a partially-matching prefix (someone hand-edited the file to add a different intro) is left alone rather than mangled.

- **`isoStamp` is locked to UTC minute granularity.** The helper formats `new Date()` as `YYYY-MM-DD HH:MM UTC` — the seconds and milliseconds are deliberately dropped so two near-simultaneous regen entries don't read as different times to a casual reviewer. The tradeoff is that two regens within the same minute will share a stamp; that's acceptable because the `<!-- regen:<newRef> -->` marker disambiguates them.

- **`plural` is a one-line helper.** `plural(n)` returns `""` for 1 and `"s"` otherwise — used in `${count} commit${plural(count)}` interpolations in both the queue stub and the fallback. The function is exhaustively obvious but lives here so every entry-emitting function uses the same rule for free.

- **`HEADER` is the single header source.** The constant defines the file preamble used both when creating the file from scratch (the `prior = HEADER` fallback in `append`) and as the substitution target in `migrateHeader`. Changing it requires a corresponding update to `migrateHeader`'s match list so the migration keeps working — otherwise old files would never be rewritten. The header also documents that the per-regen narratives are LLM-emitted, which is the contract `appendNarrative` fulfills.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/tools/wiki-tools.ts](wiki-tools.md)
- [src/wiki/index.ts](index.md)
- [src/wiki/lint-page.ts](lint-page.md)
- [Wiki orchestration](../wiki-orchestration.md)
