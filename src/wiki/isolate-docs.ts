import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { FileLevelGraph, FileLevelNode } from "./types";

/**
 * Human-readable text extensions worth feeding back to the LLM as context.
 * Prose (`.md`, `.rst`, `.txt`) describes code; shell scripts (`.sh` and
 * variants) describe bootstrap, hooks, and CI. Config/data/lock files are
 * excluded — they're either handled elsewhere (`readConfigFiles`) or have
 * no narrative value.
 */
const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
]);

/**
 * Minimum shared-prefix segment count before a community "claims" an isolate.
 * Depth 1 would trivially match any file under `src/` to the biggest
 * `src/*` community, so we require at least two overlapping directory
 * segments (e.g. `src/wiki/foo.md` + community under `src/wiki`).
 */
const MIN_SHARED_SEGMENTS = 2;

/** Cohesion-aware caps mirroring the export caps in community-synthesis.ts. */
const MAX_DOCS_HIGH_COHESION = 8;
const MAX_DOCS_LOW_COHESION = 3;
const LOW_COHESION_THRESHOLD = 0.15;

export interface NearbyDoc {
  path: string;
  content: string;
}

/**
 * A graph isolate is a node the resolver couldn't parse — no imports in, no
 * imports out, no exports. In practice: markdown, shell, config, data files.
 */
function isGraphIsolate(node: FileLevelNode): boolean {
  return node.fanIn === 0 && node.fanOut === 0 && node.exports.length === 0;
}

function isDocFile(path: string): boolean {
  const idx = path.lastIndexOf(".");
  if (idx < 0) return false;
  return DOC_EXTENSIONS.has(path.slice(idx).toLowerCase());
}

/**
 * Read all isolate doc files off disk, size-capped. Returns the subset the
 * LLM can do something with — prose in markdown/text. Binary, config, and
 * scripts are filtered out.
 */
export function collectIsolateDocs(
  fileGraph: FileLevelGraph,
  projectDir: string,
): NearbyDoc[] {
  const docs: NearbyDoc[] = [];
  for (const node of fileGraph.nodes) {
    if (!isGraphIsolate(node)) continue;
    if (!isDocFile(node.path)) continue;
    const content = readTextFile(join(projectDir, node.path));
    if (content === null) continue;
    docs.push({ path: node.path, content });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs;
}

function readTextFile(fullPath: string): string | null {
  if (!existsSync(fullPath)) return null;
  try {
    const s = statSync(fullPath);
    if (!s.isFile()) return null;
    return readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Count how many leading directory segments two paths share.
 * `src/wiki/a.ts` + `src/wiki/b.md` → 2. `src/wiki/a.ts` + `src/db/b.ts` → 1.
 * `docs/tools.md` + `src/tools/x.ts` → 0.
 */
function sharedPrefixDepth(a: string, b: string): number {
  // Strip filename — we match on directory ancestry, not basename.
  const aDirs = a.split("/").slice(0, -1);
  const bDirs = b.split("/").slice(0, -1);
  const min = Math.min(aDirs.length, bDirs.length);
  let shared = 0;
  for (let i = 0; i < min; i++) {
    if (aDirs[i] === bDirs[i]) shared++;
    else break;
  }
  return shared;
}

export interface CommunityClaim {
  communityId: string;
  memberFiles: string[];
  cohesion: number;
}

export interface AttachmentResult {
  /** Docs claimed by a specific community, keyed by community id. */
  byCommunityId: Map<string, NearbyDoc[]>;
  /** Docs nobody claimed — architecture-bundle fodder. */
  unmatched: NearbyDoc[];
}

/**
 * Attach each doc to the community whose member files share the longest
 * directory prefix. Ties → community with the most members (arbitrary but
 * deterministic). Below `MIN_SHARED_SEGMENTS` the doc is unmatched and
 * deferred to the architecture bundle.
 *
 * Per-community caps keep low-cohesion grab-bags from ballooning on
 * loosely-related markdown.
 */
export function attachIsolateDocs(
  docs: NearbyDoc[],
  communities: CommunityClaim[],
): AttachmentResult {
  const byCommunityId = new Map<string, NearbyDoc[]>();
  for (const c of communities) byCommunityId.set(c.communityId, []);
  const unmatched: NearbyDoc[] = [];

  for (const doc of docs) {
    let best: { community: CommunityClaim; depth: number } | null = null;
    for (const c of communities) {
      let maxDepth = 0;
      for (const f of c.memberFiles) {
        const d = sharedPrefixDepth(doc.path, f);
        if (d > maxDepth) maxDepth = d;
      }
      if (maxDepth < MIN_SHARED_SEGMENTS) continue;
      if (
        !best ||
        maxDepth > best.depth ||
        (maxDepth === best.depth && c.memberFiles.length > best.community.memberFiles.length)
      ) {
        best = { community: c, depth: maxDepth };
      }
    }

    if (!best) {
      unmatched.push(doc);
      continue;
    }
    const cap =
      best.community.cohesion < LOW_COHESION_THRESHOLD
        ? MAX_DOCS_LOW_COHESION
        : MAX_DOCS_HIGH_COHESION;
    const list = byCommunityId.get(best.community.communityId)!;
    if (list.length < cap) {
      list.push(doc);
    } else {
      unmatched.push(doc);
    }
  }

  return { byCommunityId, unmatched };
}
