import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PageManifest, PreRegenSnapshot } from "./types";

const LOG_FILENAME = "_update-log.md";
export const SNAPSHOT_FILENAME = "_pre-regen-snapshot.json";

const HEADER =
  `# Wiki Update Log\n\n` +
  `Changelog-style: newest entries at the top. Per-regen \"What changed\" ` +
  `narratives are emitted by an LLM after writers finish, grounded in ` +
  `old-vs-new page diffs.\n\n`;

export function appendInitLog(
  wikiDir: string,
  gitRef: string,
  manifest: PageManifest,
): void {
  const counts: Record<string, number> = {};
  for (const p of Object.values(manifest.pages)) {
    counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");

  const entry =
    `## ${isoStamp()} — Full initialization (\`${gitRef}\`)\n\n` +
    `${manifest.pageCount} pages generated` +
    (breakdown ? ` (${breakdown}).\n` : `.\n`);

  append(wikiDir, entry);
}

export interface CommitEntry {
  hash: string;
  message: string;
}

/**
 * Fallback variant of the queue stub for the case where >50% of pages
 * are dirty and `buildIncrementalResponse` switches to a forced full
 * regen. Same `<!-- regen:<newRef> -->` marker so the phase-2 narrative
 * still slots under it. Crucial: the entry says *fallback*, not "Full
 * initialization" — the prior version mislabeled this and made readers
 * think a real init had run.
 */
export function appendFallbackLog(
  wikiDir: string,
  sinceRef: string,
  newRef: string,
  dirty: number,
  total: number,
  commitCount: number,
): void {
  let entry = `## ${isoStamp()} — Incremental fallback regen (\`${sinceRef}\` → \`${newRef}\`)\n\n`;
  entry += `<!-- regen:${newRef} -->\n\n`;
  entry += `Fell back to forced full regen: ${dirty}/${total} pages dirty (>50%). ` +
    `All pages regenerating across ${commitCount} commit${plural(commitCount)}.\n\n`;
  entry += `_Per-page narrative pending writer run + \`wiki_finalize_log\`._\n`;
  append(wikiDir, entry);
}

/**
 * Phase-1 stub. Written at planning time, before any writer runs. Records
 * just the queued regen — the rich per-page narrative is appended later
 * by `appendNarrative` after writers finish and the orchestrator runs
 * `wiki_finalize_log`. The stub is a stable header an LLM-produced
 * narrative slots under (lookup uses the `<!-- regen:<newRef> -->` HTML
 * comment marker, which markdown renderers ignore).
 */
export function appendQueueStub(
  wikiDir: string,
  sinceRef: string,
  newRef: string,
  changedFileCount: number,
  staleCount: number,
  addedCount: number,
  removedCount: number,
  commitCount: number,
): void {
  const total = staleCount + addedCount;
  let entry = `## ${isoStamp()} — Incremental regen queued (\`${sinceRef}\` → \`${newRef}\`)\n\n`;
  entry += `<!-- regen:${newRef} -->\n\n`;
  entry += `${changedFileCount} file${plural(changedFileCount)} changed across ` +
    `${commitCount} commit${plural(commitCount)}. ` +
    `${staleCount} regenerated, ${addedCount} added, ${removedCount} removed.\n`;
  if (total === 0 && removedCount === 0) {
    entry += `\nNo wiki pages invalidated by the changed files.\n`;
  } else {
    entry += `\n_Per-page narrative pending writer run + \`wiki_finalize_log\`._\n`;
  }
  append(wikiDir, entry);
}

const PENDING_SENTINEL_RE =
  /\n_Per-page narrative pending writer run \+ `wiki_finalize_log`\._\n/;

/**
 * Phase-2 narrative append. Locates the matching `<!-- regen:<newRef> -->`
 * marker, scopes to the stub block (marker → next `## ` heading or EOF),
 * strips the "_Per-page narrative pending…_" sentinel line, then appends
 * the narrative at the END of the stub block — under the counts, before
 * the next entry. If the marker is missing the narrative is appended
 * standalone with a recovery header.
 */
export function appendNarrative(
  wikiDir: string,
  newRef: string,
  narrative: string,
): { mode: "inserted" | "appended" } {
  const path = join(wikiDir, LOG_FILENAME);
  const marker = `<!-- regen:${newRef} -->`;
  const block =
    `\n### What changed in this regen\n\n` +
    narrative.trim() + "\n";
  const prior = existsSync(path) ? readFileSync(path, "utf-8") : HEADER;
  const idx = prior.indexOf(marker);
  if (idx === -1) {
    const recovery =
      `## ${isoStamp()} — Narrative (orphan, \`${newRef}\`)\n\n` +
      `_Queue stub not found for \`${newRef}\`; appending narrative standalone._\n` +
      block;
    append(wikiDir, recovery);
    return { mode: "appended" };
  }
  // Find end of stub block: next `\n## ` heading after the marker, or EOF.
  const tailSearchStart = idx + marker.length;
  const nextHeading = prior.indexOf("\n## ", tailSearchStart);
  const blockEnd = nextHeading === -1 ? prior.length : nextHeading + 1;
  let stub = prior.slice(idx, blockEnd);
  // Drop the pending sentinel — the narrative replaces it.
  stub = stub.replace(PENDING_SENTINEL_RE, "\n");
  // Trim trailing whitespace inside the stub before appending narrative.
  stub = stub.replace(/\s+$/, "") + "\n";
  const before = prior.slice(0, idx);
  const after = prior.slice(blockEnd);
  const tailSep = after.startsWith("\n") ? "" : "\n";
  writeFileSync(path, before + stub + block + tailSep + after);
  return { mode: "inserted" };
}

// ── Snapshot IO ──

export function snapshotPath(wikiDir: string): string {
  return join(wikiDir, "_meta", SNAPSHOT_FILENAME);
}

export function writeSnapshot(wikiDir: string, snap: PreRegenSnapshot): void {
  const path = snapshotPath(wikiDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap, null, 2));
  // rename via writeFileSync + unlink fallback — keep deps minimal.
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function readSnapshot(wikiDir: string): PreRegenSnapshot | null {
  const path = snapshotPath(wikiDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as PreRegenSnapshot;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteSnapshot(wikiDir: string): void {
  const path = snapshotPath(wikiDir);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

/**
 * Insert a new top-level entry directly after the header so the file
 * reads changelog-style (newest first). Existing entries that pre-date
 * this convention stay in their original order below — no rewrite. The
 * "header" is everything up to the first `## ` heading; if none exists,
 * the entry goes after the prior content.
 */
function append(wikiDir: string, entry: string): void {
  const path = join(wikiDir, LOG_FILENAME);
  mkdirSync(dirname(path), { recursive: true });
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : HEADER;
  const prior = migrateHeader(raw);
  const firstEntry = prior.indexOf("\n## ");
  const block = entry.endsWith("\n") ? entry : entry + "\n";
  if (firstEntry === -1) {
    const sep = prior.endsWith("\n\n") ? "" : prior.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(path, prior + sep + block);
    return;
  }
  const head = prior.slice(0, firstEntry + 1);
  const tail = prior.slice(firstEntry + 1);
  const headSep = head.endsWith("\n\n") ? "" : head.endsWith("\n") ? "\n" : "\n\n";
  const blockSep = block.endsWith("\n\n") ? "" : "\n";
  writeFileSync(path, head + headSep + block + blockSep + tail);
}

/**
 * Replace the legacy "Append-only … Newest entries at the bottom"
 * preamble with the current changelog-style HEADER. Idempotent: the
 * current header passes through unchanged. Touching the file on every
 * append keeps the convention truthful even for logs that pre-date the
 * newest-first switch.
 */
export function migrateHeader(raw: string): string {
  if (raw.startsWith(HEADER)) return raw;
  const firstHeading = raw.indexOf("\n## ");
  const headEnd = firstHeading === -1 ? raw.length : firstHeading;
  const head = raw.slice(0, headEnd);
  const tail = raw.slice(headEnd);
  const looksLikeOldHeader =
    head.startsWith("# Wiki Update Log") &&
    (head.includes("Newest entries at the bottom") ||
      head.includes("Append-only log of wiki generation"));
  if (!looksLikeOldHeader) return raw;
  const tailSep = tail.startsWith("\n") ? "" : "\n";
  return HEADER.replace(/\n+$/, "\n\n") + (tail ? tailSep + tail.replace(/^\n+/, "") : "");
}

function isoStamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
