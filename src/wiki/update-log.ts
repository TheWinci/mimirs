import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PageManifest } from "./types";
import type { StalenessReport } from "./staleness";

const LOG_FILENAME = "_update-log.md";

const HEADER =
  `# Wiki Update Log\n\n` +
  `Append-only log of wiki generation and incremental updates. ` +
  `Newest entries at the bottom. Emitted deterministically from the ` +
  `staleness report — not LLM-generated.\n\n`;

export function appendInitLog(
  wikiDir: string,
  gitRef: string,
  manifest: PageManifest,
): void {
  const counts: Record<string, number> = {};
  for (const p of Object.values(manifest.pages)) {
    counts[p.tier] = (counts[p.tier] ?? 0) + 1;
  }
  const breakdown = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tier, count]) => `${count} ${tier}`)
    .join(", ");

  const entry =
    `## ${isoStamp()} — Full initialization (\`${gitRef}\`)\n\n` +
    `${manifest.pageCount} pages generated` +
    (breakdown ? ` (${breakdown}).\n` : `.\n`);

  append(wikiDir, entry);
}

export function appendIncrementalLog(
  wikiDir: string,
  sinceRef: string,
  newRef: string,
  changedFileCount: number,
  report: StalenessReport,
): void {
  const { stale, added, removed } = report;
  const byOrder = (a: { order: number }, b: { order: number }) =>
    a.order - b.order;

  let entry =
    `## ${isoStamp()} — Incremental update (\`${sinceRef}\` → \`${newRef}\`)\n\n` +
    `${changedFileCount} file${plural(changedFileCount)} changed. ` +
    `${stale.length} regenerated, ${added.length} added, ${removed.length} removed.\n`;

  if (stale.length === 0 && added.length === 0 && removed.length === 0) {
    entry += `\nNo wiki pages invalidated by the changed files.\n`;
    append(wikiDir, entry);
    return;
  }

  if (stale.length > 0) {
    entry += `\n### Regenerated\n\n`;
    for (const d of [...stale].sort(byOrder)) {
      const kind = d.page.focus ?? d.page.kind;
      entry += `- \`${d.wikiPath}\` — ${d.page.title} (${kind}, ${d.page.depth})\n`;
      entry += `  - trigger: ${d.triggers.map((t) => `\`${t}\``).join(", ")}\n`;
    }
  }

  if (added.length > 0) {
    entry += `\n### Added\n\n`;
    for (const d of [...added].sort(byOrder)) {
      const kind = d.page.focus ?? d.page.kind;
      entry += `- \`${d.wikiPath}\` — ${d.page.title} (${kind}, ${d.page.depth})\n`;
    }
  }

  if (removed.length > 0) {
    entry += `\n### Removed\n\n`;
    for (const r of removed) {
      entry += `- \`${r.wikiPath}\` — ${r.page.title}\n`;
    }
  }

  append(wikiDir, entry);
}

function append(wikiDir: string, entry: string): void {
  const path = join(wikiDir, LOG_FILENAME);
  const prior = existsSync(path) ? readFileSync(path, "utf-8") : HEADER;
  const separator = prior.endsWith("\n\n") ? "" : prior.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, prior + separator + entry);
}

function isoStamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
