/**
 * Shared helpers for the SWE-bench-Live file-localization benchmark.
 *
 * We use SWE-bench-Live as a retrieval ground-truth source: query = issue text,
 * gold = files the fix patch touches, metric = did mimirs rank the gold file in
 * top-K. See plans/swe-bench-live-localization.md.
 */

import { existsSync, mkdirSync } from "fs";

const DATASET = "SWE-bench-Live/SWE-bench-Live";
const ROWS_URL = "https://datasets-server.huggingface.co/rows";

export interface SweRow {
  instance_id: string;
  repo: string; // "owner/name"
  base_commit: string;
  patch: string; // the fix diff
  test_patch: string;
  problem_statement: string;
  created_at: string;
}

/** Fetch one page of rows from the HF datasets-server REST API. */
export async function fetchRows(split: string, offset: number, length: number): Promise<SweRow[]> {
  const url =
    `${ROWS_URL}?dataset=${encodeURIComponent(DATASET)}&config=default` +
    `&split=${split}&offset=${offset}&length=${length}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HF rows fetch failed (${res.status} ${res.statusText}) for ${url}`);
  const json = (await res.json()) as { rows?: { row: SweRow }[] };
  return (json.rows ?? []).map((r) => r.row);
}

/** Page through an entire split (or up to `max` rows). */
export async function fetchAllRows(split: string, max = Infinity): Promise<SweRow[]> {
  const out: SweRow[] = [];
  const page = 100;
  for (let offset = 0; offset < max; offset += page) {
    const len = Math.min(page, max - offset);
    const rows = await fetchRows(split, offset, len);
    if (rows.length === 0) break;
    out.push(...rows);
    if (rows.length < len) break;
  }
  return out;
}

export interface GoldFile {
  path: string; // repo-relative POSIX path
  isNew: boolean; // created by the patch -> no pre-image at base_commit -> not retrievable
}

/**
 * Parse a unified-diff fix patch into the files it touches.
 *
 * For each `diff --git a/<A> b/<B>` block:
 *  - new file (block contains `--- /dev/null`)  -> gold path = B, isNew = true
 *  - otherwise (modify / delete / rename)        -> gold path = A (the path that
 *    exists at base_commit, i.e. what a developer would actually open)
 */
export function parseGoldFiles(patch: string): GoldFile[] {
  const blocks = patch.split(/^diff --git /m).slice(1);
  const seen = new Set<string>();
  const result: GoldFile[] = [];
  for (const block of blocks) {
    const header = block.slice(0, block.indexOf("\n"));
    const hm = header.match(/^a\/(.+?) b\/(.+?)\s*$/);
    if (!hm) continue;
    const aPath = hm[1].trim();
    const bPath = hm[2].trim();
    const isNew = /^--- \/dev\/null\s*$/m.test(block);
    const path = isNew ? bPath : aPath;
    if (!seen.has(path)) {
      seen.add(path);
      result.push({ path, isNew });
    }
  }
  return result;
}

const matches = (a: string, b: string) => a === b || a.endsWith(b) || b.endsWith(a);

/**
 * Recompute localization metrics at a sub-K from a stored ranked path list.
 * `goldAbs` are absolute (or repo-relative) gold paths; matching is suffix-tolerant
 * to bridge relative-vs-absolute, exactly like src/search/benchmark.ts.
 */
export function metricsAtK(rankedPaths: string[], goldAbs: string[], k: number) {
  const top = rankedPaths.slice(0, k);
  const found = goldAbs.filter((g) => top.some((r) => matches(r, g)));
  const recall = goldAbs.length ? found.length / goldAbs.length : 0;
  let rr = 0;
  for (let i = 0; i < top.length; i++) {
    if (goldAbs.some((g) => matches(top[i], g))) {
      rr = 1 / (i + 1);
      break;
    }
  }
  return { recall, hit: found.length > 0, rr };
}

/**
 * Shallow-fetch a single commit of a GitHub repo into `destDir` and check it out.
 * GitHub allows fetching by SHA (allowReachableSHA1InWant), so we avoid cloning
 * full history. Reuses an existing repo dir if present (re-fetches the new SHA).
 * Returns true on success.
 */
export function shallowFetchCheckout(repo: string, commit: string, destDir: string): boolean {
  const run = (args: string[], cwd?: string) =>
    Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (!existsSync(`${destDir}/.git`)) {
    mkdirSync(destDir, { recursive: true });
    if (!run(["init", "-q"], destDir)) return false;
    if (!run(["remote", "add", "origin", `https://github.com/${repo}.git`], destDir)) return false;
  }
  if (!run(["fetch", "-q", "--depth", "1", "origin", commit], destDir)) return false;
  return run(["checkout", "-q", "-f", "FETCH_HEAD"], destDir);
}
