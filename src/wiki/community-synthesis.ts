import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import Graph from "graphology";
import type { RagDB } from "../db";
import type {
  DiscoveryModule,
  DiscoveryResult,
  ClassifiedInventory,
  ClassifiedSymbol,
  CommunityBundle,
  FileLevelGraph,
} from "./types";
import { computePageRank } from "./pagerank";
import {
  attachIsolateDocs,
  collectIsolateDocs,
  type NearbyDoc,
} from "./isolate-docs";
import { catalogEntry, type SectionCatalogEntry } from "./section-catalog";

/**
 * Thresholds for mandatory sections. Mirrors the v1.1.6 `section-selector`
 * predicates that produced v64-quality output: data-driven, not LLM-chosen.
 * LLM may add more sections, but may not skip these when their predicate fires.
 *
 * Centralised in a single `DEPTH_PROFILE` object so future tuning is
 * configuration-change, not a grep-and-replace. Add a profile entry and fire
 * its catalog id from `requiredSectionsFor`.
 */
const DEPTH_PROFILE = {
  perFile: { minFiles: 3, minExports: 5 },
  flow: { minFiles: 2 },
  internals: { minLoc: 400, minTunables: 8, minFiles: 10 },
  depGraph: { minEdges: 3 },
  /**
   * Deep-community profile: a bundle large enough that the default 5-section
   * template shallows out. When either threshold fires, `design-rationale`,
   * `trade-offs`, and `common-gotchas` are added so the writer has room to
   * explain the shape of the thing rather than just enumerate its parts.
   */
  deep: { minTopMemberLoc: 800, minFiles: 10 },
} as const;

/**
 * Split thresholds. A community is split into per-file / per-group sub-pages
 * when either (a) total LOC across members exceeds `SPLIT_TOTAL_LOC`, or (b)
 * it has `SPLIT_BIG_MEMBER_COUNT` or more "big" members. Big = per-file LOC
 * ≥ `BIG_FILE_LOC` or per-file exports ≥ `BIG_FILE_EXPORTS`.
 *
 * Count-based trigger was too eager: every 10-file community split into 10
 * thin pages even when each was 50 LOC. Size-based trigger only splits when
 * the parent page would genuinely be unreadable in one shot. Small helpers
 * get grouped into a single sub-page instead of scattering.
 */
export const SPLIT_TOTAL_LOC = 5000;
export const SPLIT_BIG_MEMBER_COUNT = 4;
export const BIG_FILE_LOC = 500;
export const BIG_FILE_EXPORTS = 8;

/** True if the community warrants sub-pages (see thresholds above). */
export function isSplitCommunity(bundle: CommunityBundle): boolean {
  const { bigCount, totalLoc } = classifyMembers(bundle);
  return totalLoc >= SPLIT_TOTAL_LOC || bigCount >= SPLIT_BIG_MEMBER_COUNT;
}

/**
 * Classify each member as big vs small using LOC + per-file export count.
 * Shared helper so page-tree and synthesis agree on what "big" means.
 */
export function classifyMembers(bundle: CommunityBundle): {
  big: string[];
  small: string[];
  bigCount: number;
  totalLoc: number;
} {
  const exportsByFile = new Map<string, number>();
  for (const e of bundle.exports) {
    exportsByFile.set(e.file, (exportsByFile.get(e.file) ?? 0) + 1);
  }
  const big: string[] = [];
  const small: string[] = [];
  let totalLoc = 0;
  for (const f of bundle.memberFiles) {
    const loc = bundle.memberLoc[f] ?? 0;
    totalLoc += loc;
    const exp = exportsByFile.get(f) ?? 0;
    if (loc >= BIG_FILE_LOC || exp >= BIG_FILE_EXPORTS) big.push(f);
    else small.push(f);
  }
  return { big, small, bigCount: big.length, totalLoc };
}

/**
 * Sections whose predicate fires for this bundle. Each returned entry is a
 * full catalog entry ready to inject into the synthesis prompt (and into the
 * payload post-hoc if the LLM skipped it). The `reason` explains which signal
 * triggered the requirement — shown to the LLM so it understands why.
 */
export interface RequiredSection {
  entry: SectionCatalogEntry;
  reason: string;
}

export function requiredSectionsFor(
  bundle: CommunityBundle,
): RequiredSection[] {
  const out: RequiredSection[] = [];
  const files = bundle.memberFiles.length;
  const exports = bundle.exports.length;
  const loc = bundle.topMemberLoc;
  const tunables = bundle.tunableCount;
  const annotations = bundle.annotations.length;

  const push = (id: string, reason: string): void => {
    const entry = catalogEntry(id);
    if (entry) out.push({ entry, reason });
  };

  if (
    files >= DEPTH_PROFILE.perFile.minFiles &&
    exports >= DEPTH_PROFILE.perFile.minExports
  ) {
    const reason = isSplitCommunity(bundle)
      ? `${files} files × ${exports} exports, split community — cover non-big members here; bigs have own sub-pages`
      : `${files} files × ${exports} exports — per-file prose section required`;
    push("per-file-breakdown", reason);
  }
  if (files >= DEPTH_PROFILE.flow.minFiles) {
    push(
      "lifecycle-flow",
      `${files} files — trace the flow across them with a sequenceDiagram + numbered walkthrough`,
    );
  }
  const edgeCount =
    bundle.externalConsumers.length + bundle.externalDependencies.length;
  if (edgeCount >= DEPTH_PROFILE.depGraph.minEdges) {
    push(
      "dependency-graph",
      `${edgeCount} external edges (${bundle.externalDependencies.length} up, ${bundle.externalConsumers.length} down) — worth a flowchart`,
    );
  }
  if (
    loc >= DEPTH_PROFILE.internals.minLoc ||
    tunables >= DEPTH_PROFILE.internals.minTunables ||
    files >= DEPTH_PROFILE.internals.minFiles
  ) {
    push(
      "internals",
      `${loc} LOC top member / ${tunables} tunables / ${files} files — surface insider gotchas`,
    );
  }
  if (annotations >= 1) {
    push(
      "known-issues",
      `${annotations} annotation${annotations === 1 ? "" : "s"} on member files`,
    );
  }
  if (tunables >= 1) {
    push(
      "tuning-knobs",
      `${tunables} tunable${tunables === 1 ? "" : "s"} — surface defaults + effect`,
    );
  }
  if (
    loc >= DEPTH_PROFILE.deep.minTopMemberLoc ||
    files >= DEPTH_PROFILE.deep.minFiles
  ) {
    const deepReason =
      `deep community (${loc} LOC top member / ${files} files) — add shape-level sections so the page doesn't flatten into a symbol dump`;
    push("design-rationale", deepReason);
    push("trade-offs", deepReason);
    push("common-gotchas", deepReason);
  }
  return out;
}

const MAX_EXPORTS_IN_BUNDLE = 60;
const MAX_EXPORTS_LOW_COHESION = 15;
const LOW_COHESION_THRESHOLD = 0.15;
const MAX_COMMITS = 10;
/**
 * Cap on how many tunables we ship in a bundle. A single config file can
 * legitimately expose dozens; 40 covers real-world tuning-heavy communities
 * without ballooning the prompt.
 */
const MAX_TUNABLES = 40;
const TUNABLE_TYPES = new Set(["constant", "variable"]);
/**
 * Per-file cap for member preview snippets (rank 2..N). Gives the writer
 * enough to read imports + top-level signatures without shipping full bodies.
 */
const MAX_PREVIEW_LINES = 60;
const MAX_PREVIEW_BYTES_PER_FILE = 2 * 1024;
/**
 * Total preview byte budget across all rank-2..N members. Protects the prompt
 * from ballooning on wide communities; rank order means highest-signal files
 * survive trimming.
 */
const MAX_TOTAL_PREVIEW_BYTES = 24 * 1024;
/**
 * Per-doc and total byte caps for nearby-docs inlined into synthesis / page
 * payloads. Full doc bodies blow up the prompt on repos with large READMEs
 * or design notes; a 2 KiB head plus a 12 KiB aggregate cap preserves enough
 * framing for naming without swamping the LLM. Writer can Read full doc if
 * deeper detail is needed.
 */
const MAX_NEARBY_DOC_BYTES = 2 * 1024;
const MAX_TOTAL_NEARBY_DOC_BYTES = 12 * 1024;
/**
 * Sample size for externalConsumers / externalDependencies inlined in the
 * synthesis prompt. Previously we shipped up to 30 each; downstream resolution
 * is lazy (LLM can call `depends_on` / `depended_on_by` when it needs the
 * full list) so a head sample plus a count is enough for naming.
 *
 * Bumping this (tried 5→15) increased per-page agentic verification work
 * — writers cited every shown edge — net cost +63% on a real wiki gen. Keep
 * the sample tight; trust the lazy-fetch escape hatch.
 */
const EXTERNAL_DEP_SAMPLE = 5;

/**
 * Per-file cap for `consumersByFile` / `dependenciesByFile` lists. A hub
 * file can have 50+ importers; shipping the full list inflates `_bundles.json`
 * (and every cached payload reads) for data the renderer slices to 8 anyway.
 * 30 leaves headroom for sub-page scoping (which unions per-file values into
 * a scoped `externalConsumers`) without truncating real fan-in coverage.
 */
const MAX_PER_FILE_EDGES = 30;

/**
 * Derive a stable community id from its member files. Identical member sets
 * across runs produce identical ids; any file added or removed produces a
 * new id, which is the signal for regeneration.
 */
export function communityIdFor(memberFiles: string[]): string {
  const sorted = [...memberFiles].sort();
  const h = createHash("sha256");
  h.update(sorted.join("\n"));
  return h.digest("hex").slice(0, 16);
}

/**
 * Build one bundle per community. Deterministic — no LLM calls here.
 *
 * Everything the shape-deciding LLM (step 4) might want is in the bundle so
 * it doesn't have to search. The LLM retains tool access (it can still call
 * `read_relevant`, `find_usages`, etc. if the bundle leaves a gap) but in
 * the common case shouldn't need to.
 */
export interface BundleBuildResult {
  bundles: CommunityBundle[];
  /** Isolate docs no community claimed — handed to the architecture bundle. */
  unmatchedDocs: NearbyDoc[];
}

export function buildCommunityBundles(
  db: RagDB,
  discovery: DiscoveryResult,
  classified: ClassifiedInventory,
  projectDir: string,
): BundleBuildResult {
  const communities = flattenModules(discovery.modules);
  const symbolsByFile = new Map<string, ClassifiedSymbol[]>();
  for (const s of classified.symbols) {
    if (!symbolsByFile.has(s.file)) symbolsByFile.set(s.file, []);
    symbolsByFile.get(s.file)!.push(s);
  }

  // Stable community ids derived once so we can thread matched docs through.
  const communityIds = communities.map((c) => communityIdFor([...c.files].sort()));
  const isolateDocs = collectIsolateDocs(discovery.graphData.fileLevel, projectDir);
  const { byCommunityId, unmatched } = attachIsolateDocs(
    isolateDocs,
    communities.map((c, i) => ({
      communityId: communityIds[i],
      memberFiles: c.files,
      cohesion: c.cohesion,
    })),
  );

  // Precompute project-wide DB lookups in batch — one query per kind across
  // every member file in the wiki. Without this, `buildOneBundle` made
  // O(communities × members × 4) round-trips (getFileByPath, getDependsOn,
  // getDependedOnBy, getAnnotations); for 1k-file projects that was the
  // dominant wall-time cost of bundling. With batching it's O(4) plus
  // per-community lookups against the precomputed maps.
  const allMemberPaths = [...new Set(communities.flatMap((c) => c.files))];
  const fileRowsByPath = new Map<string, { id: number; path: string }>();
  for (const f of db.getFilesByPaths(allMemberPaths.map((p) => resolve(projectDir, p)))) {
    fileRowsByPath.set(f.path, f);
  }
  const pathByFileId = new Map<number, string>();
  for (const [, f] of fileRowsByPath) pathByFileId.set(f.id, f.path);
  const allFileIds = [...fileRowsByPath.values()].map((f) => f.id);

  const depsByFromId = new Map<number, string[]>();
  for (const row of db.getDependsOnForFiles(allFileIds)) {
    let arr = depsByFromId.get(row.fromFileId);
    if (!arr) { arr = []; depsByFromId.set(row.fromFileId, arr); }
    arr.push(row.toPath);
  }
  const consumersByToId = new Map<number, string[]>();
  for (const row of db.getDependedOnByForFiles(allFileIds)) {
    let arr = consumersByToId.get(row.toFileId);
    if (!arr) { arr = []; consumersByToId.set(row.toFileId, arr); }
    arr.push(row.fromPath);
  }

  const annotationsByPath = new Map<string, { line: number; note: string }[]>();
  for (const a of db.getAnnotationsForPaths(allMemberPaths.map((p) => resolve(projectDir, p)))) {
    let arr = annotationsByPath.get(a.path);
    if (!arr) { arr = []; annotationsByPath.set(a.path, arr); }
    arr.push({ line: (a as { line?: number }).line ?? 0, note: a.note });
  }

  // Git history is keyed on the same project-relative path style the wiki
  // pipeline uses; topK matches MAX_COMMITS so the per-file slice mirrors
  // the prior per-call `getFileHistory(file, MAX_COMMITS)` behaviour.
  const historyByPath = db.getFileHistoryForPaths(allMemberPaths, MAX_COMMITS);

  const lookups: BundleLookups = {
    fileRowsByPath,
    pathByFileId,
    depsByFromId,
    consumersByToId,
    annotationsByPath,
    historyByPath,
  };

  const bundles = communities.map((community, i) =>
    buildOneBundle(
      community,
      discovery.graphData.fileLevel,
      symbolsByFile,
      db,
      projectDir,
      byCommunityId.get(communityIds[i]) ?? [],
      lookups,
    ),
  );
  return { bundles, unmatchedDocs: unmatched };
}

interface BundleLookups {
  fileRowsByPath: Map<string, { id: number; path: string }>;
  pathByFileId: Map<number, string>;
  depsByFromId: Map<number, string[]>;
  consumersByToId: Map<number, string[]>;
  annotationsByPath: Map<string, { line: number; note: string }[]>;
  historyByPath: Map<string, { hash: string; message: string; date: string }[]>;
}

function buildOneBundle(
  community: DiscoveryModule,
  fileGraph: FileLevelGraph,
  symbolsByFile: Map<string, ClassifiedSymbol[]>,
  db: RagDB,
  projectDir: string,
  nearbyDocs: NearbyDoc[],
  lookups: BundleLookups,
): CommunityBundle {
  const memberFiles = [...community.files].sort();
  const memberSet = new Set(memberFiles);
  const communityId = communityIdFor(memberFiles);

  const pageRank = perCommunityPageRank(memberFiles, fileGraph);

  const exports: CommunityBundle["exports"] = [];
  const tunablesAll: CommunityBundle["tunables"] = [];
  for (const file of memberFiles) {
    const syms = symbolsByFile.get(file) ?? [];
    for (const s of syms) {
      const rawSnippet = s.snippet ?? `${s.type} ${s.name}`;
      exports.push({
        name: s.name,
        type: s.type,
        file: s.file,
        signature: truncateSignature(rawSnippet),
      });
      if (TUNABLE_TYPES.has(s.type)) {
        tunablesAll.push({
          name: s.name,
          type: s.type,
          file: s.file,
          snippet: rawSnippet,
        });
      }
    }
  }
  exports.sort((a, b) => {
    const ra = pageRank.get(a.file) ?? 0;
    const rb = pageRank.get(b.file) ?? 0;
    return rb - ra || a.file.localeCompare(b.file);
  });
  tunablesAll.sort((a, b) => {
    const ra = pageRank.get(a.file) ?? 0;
    const rb = pageRank.get(b.file) ?? 0;
    return rb - ra || a.file.localeCompare(b.file) || a.name.localeCompare(b.name);
  });
  const cap = community.cohesion < LOW_COHESION_THRESHOLD
    ? MAX_EXPORTS_LOW_COHESION
    : MAX_EXPORTS_IN_BUNDLE;
  const exportCount = exports.length;
  const cappedExports = exports.slice(0, cap);
  const tunableCount = tunablesAll.length;
  const tunables = tunablesAll.slice(0, MAX_TUNABLES);

  const memberLoc: Record<string, number> = {};
  let topMemberLoc = 0;
  for (const file of memberFiles) {
    try {
      const content = readFileSync(resolve(projectDir, file), "utf-8");
      const loc = content.split("\n").length;
      memberLoc[file] = loc;
      if (loc > topMemberLoc) topMemberLoc = loc;
    } catch {
      memberLoc[file] = 0;
    }
  }

  const externalConsumers = new Set<string>();
  const externalDependencies = new Set<string>();
  const consumersByFile: Record<string, string[]> = {};
  const dependenciesByFile: Record<string, string[]> = {};
  for (const file of memberFiles) {
    const fileObj = lookups.fileRowsByPath.get(resolve(projectDir, file));
    if (!fileObj) {
      consumersByFile[file] = [];
      dependenciesByFile[file] = [];
      continue;
    }
    const fileDeps = new Set<string>();
    for (const depPath of lookups.depsByFromId.get(fileObj.id) ?? []) {
      if (memberSet.has(depPath)) continue;
      externalDependencies.add(depPath);
      fileDeps.add(depPath);
    }
    const fileConsumers = new Set<string>();
    for (const consumerPath of lookups.consumersByToId.get(fileObj.id) ?? []) {
      if (memberSet.has(consumerPath)) continue;
      externalConsumers.add(consumerPath);
      fileConsumers.add(consumerPath);
    }
    consumersByFile[file] = [...fileConsumers].sort().slice(0, MAX_PER_FILE_EDGES);
    dependenciesByFile[file] = [...fileDeps].sort().slice(0, MAX_PER_FILE_EDGES);
  }

  const annotations: CommunityBundle["annotations"] = [];
  for (const file of memberFiles) {
    const notes = lookups.annotationsByPath.get(resolve(projectDir, file)) ?? [];
    for (const n of notes) {
      annotations.push({ file, line: n.line, note: n.note });
    }
  }

  const commitsByHash = new Map<string, CommunityBundle["recentCommits"][number]>();
  for (const file of memberFiles) {
    const history = lookups.historyByPath.get(file) ?? [];
    for (const c of history) {
      const existing = commitsByHash.get(c.hash);
      if (existing) {
        if (!existing.files.includes(file)) existing.files.push(file);
      } else {
        commitsByHash.set(c.hash, {
          sha: c.hash,
          message: c.message,
          date: c.date,
          files: [file],
        });
      }
    }
  }
  const recentCommits = [...commitsByHash.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_COMMITS);

  const topRankedFile = [...pageRank.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const memberPreviews = buildMemberPreviews(
    memberFiles,
    topRankedFile,
    pageRank,
    memberLoc,
    projectDir,
  );

  return {
    communityId,
    memberFiles,
    exports: cappedExports,
    tunables,
    topMemberLoc,
    memberLoc,
    tunableCount,
    exportCount,
    externalConsumers: [...externalConsumers].sort(),
    externalDependencies: [...externalDependencies].sort(),
    consumersByFile,
    dependenciesByFile,
    recentCommits,
    annotations,
    topRankedFile,
    memberPreviews,
    pageRank: Object.fromEntries(pageRank),
    cohesion: community.cohesion,
    nearbyDocs,
  };
}

/**
 * Read first-N-lines previews for every member except the top-ranked file
 * (the writer is instructed to Read that one directly). Sorted by per-file
 * PageRank descending; trimmed from the tail when the total preview byte
 * budget is exceeded so the writer sees the highest-signal non-top files
 * first.
 */
function buildMemberPreviews(
  memberFiles: string[],
  topRankedFile: string | null,
  pageRank: Map<string, number>,
  memberLoc: Record<string, number>,
  projectDir: string,
): CommunityBundle["memberPreviews"] {
  const candidates = memberFiles.filter((f) => f !== topRankedFile);
  candidates.sort((a, b) => {
    const ra = pageRank.get(a) ?? 0;
    const rb = pageRank.get(b) ?? 0;
    return rb - ra || a.localeCompare(b);
  });

  const previews: CommunityBundle["memberPreviews"] = [];
  let totalBytes = 0;
  for (const file of candidates) {
    if (totalBytes >= MAX_TOTAL_PREVIEW_BYTES) break;
    try {
      const raw = readFileSync(resolve(projectDir, file), "utf-8");
      const firstLines = raw.split("\n").slice(0, MAX_PREVIEW_LINES).join("\n");
      let trimmed = firstLines;
      if (Buffer.byteLength(trimmed, "utf-8") > MAX_PREVIEW_BYTES_PER_FILE) {
        trimmed = Buffer.from(trimmed, "utf-8")
          .subarray(0, MAX_PREVIEW_BYTES_PER_FILE)
          .toString("utf-8");
      }
      const bytes = Buffer.byteLength(trimmed, "utf-8");
      if (totalBytes + bytes > MAX_TOTAL_PREVIEW_BYTES) break;
      previews.push({ file, firstLines: trimmed, loc: memberLoc[file] ?? 0 });
      totalBytes += bytes;
    } catch {
      // Unreadable files are just omitted — they'll show up in breadcrumbs.
    }
  }
  return previews;
}

/**
 * Byte-clip a doc body to a head preview; preserves UTF-8 boundaries.
 * Returns the original content unchanged when it already fits.
 */
export function clipDocPreview(
  content: string,
  maxBytes: number,
): { preview: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes <= maxBytes) return { preview: content, truncated: false };
  const sliced = Buffer.from(content, "utf-8")
    .subarray(0, maxBytes)
    .toString("utf-8");
  return { preview: sliced, truncated: true };
}

/** PageRank restricted to the community's internal file subgraph. */
function perCommunityPageRank(
  memberFiles: string[],
  fileGraph: FileLevelGraph,
): Map<string, number> {
  const memberSet = new Set(memberFiles);
  const graph = new Graph({ type: "undirected", multi: false });
  for (const path of memberFiles) graph.addNode(path);

  const sortedEdges = [...fileGraph.edges].sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)
  );
  for (const edge of sortedEdges) {
    if (edge.from === edge.to) continue;
    if (!memberSet.has(edge.from) || !memberSet.has(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) {
      graph.updateEdgeAttribute(edge.from, edge.to, "weight", (w: number | undefined) => (w ?? 1) + 1);
    } else {
      graph.addEdge(edge.from, edge.to, { weight: 1 });
    }
  }

  if (graph.order === 0) return new Map();
  return computePageRank(graph);
}

/**
 * Single-line / arrow-fn / type-alias signatures can still ship 200+ chars
 * (long generic constraints, union types) — the brace-depth strip stops at
 * the body, not the signature boundary. Cap the result so a runaway type
 * signature can't dominate the exports table in a bundle.
 */
const MAX_SIGNATURE_BYTES = 240;

function truncateSignature(snippet: string): string {
  const lines = snippet.split("\n");
  let result: string;
  if (lines.length <= 1) {
    result = snippet;
  } else {
    let braceDepth = 0;
    const sig: string[] = [];
    for (const line of lines) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0) {
        sig.push(line);
      } else {
        const idx = line.indexOf("{");
        if (idx >= 0) sig.push(line.slice(0, idx).trimEnd());
        break;
      }
    }
    result = sig.join("\n").trimEnd() || snippet.split("\n")[0];
  }
  if (result.length > MAX_SIGNATURE_BYTES) {
    return result.slice(0, MAX_SIGNATURE_BYTES - 1) + "…";
  }
  return result;
}

function flattenModules(modules: DiscoveryModule[]): DiscoveryModule[] {
  const result: DiscoveryModule[] = [];
  for (const mod of modules) {
    result.push(mod);
    if (mod.children) result.push(...flattenModules(mod.children));
  }
  return result;
}

/**
 * Render the step-4 prompt for one community. Includes the bundle data and
 * the section catalog as building blocks.
 */
export function renderSynthesisPrompt(
  bundle: CommunityBundle,
  catalogMarkdown: string,
  usedSlugs: string[],
): string {
  const lines: string[] = [];
  const required = requiredSectionsFor(bundle);
  lines.push("# Community synthesis prompt");
  lines.push("");
  lines.push(`You are naming and structuring a wiki page for one community of files in this codebase.`);
  lines.push("");
  lines.push(`## Community id`);
  lines.push("");
  lines.push(`\`${bundle.communityId}\``);
  lines.push("");
  lines.push(`## Member files (${bundle.memberFiles.length})`);
  lines.push("");
  for (const f of bundle.memberFiles) lines.push(`- \`${f}\``);
  lines.push("");

  if (bundle.topRankedFile) {
    lines.push(`**Most load-bearing member (per-community PageRank):** \`${bundle.topRankedFile}\``);
    lines.push("");
  }

  lines.push(`## Exports (${bundle.exports.length}, ordered by per-file PageRank)`);
  lines.push("");
  for (const e of bundle.exports) {
    lines.push(`- **${e.name}** (${e.type}) — \`${e.file}\``);
    lines.push("  ```");
    for (const l of e.signature.split("\n").slice(0, 4)) lines.push(`  ${l}`);
    lines.push("  ```");
  }
  lines.push("");

  if (bundle.tunables.length > 0) {
    const total = bundle.tunableCount;
    const shown = bundle.tunables.length;
    const header = shown < total
      ? `## Tunables (${shown} shown of ${total})`
      : `## Tunables (${shown})`;
    lines.push(header);
    lines.push(
      "Constant/variable exports with literal values (multipliers, thresholds, " +
      "word lists, timeouts). Surface these verbatim in the page — readers " +
      "tuning behavior look here first.",
    );
    lines.push("");
    for (const t of bundle.tunables) {
      lines.push(`- **${t.name}** (${t.type}) — \`${t.file}\``);
      lines.push("  ```");
      for (const l of t.snippet.split("\n")) lines.push(`  ${l}`);
      lines.push("  ```");
    }
    lines.push("");
  }

  if (bundle.externalConsumers.length > 0) {
    lines.push(`## External consumers (${bundle.externalConsumers.length})`);
    lines.push(`Sample — call \`depended_on_by\` on a member file for the full list when naming/framing needs it.`);
    for (const f of bundle.externalConsumers.slice(0, EXTERNAL_DEP_SAMPLE)) lines.push(`- \`${f}\``);
    if (bundle.externalConsumers.length > EXTERNAL_DEP_SAMPLE) {
      lines.push(`- … (+${bundle.externalConsumers.length - EXTERNAL_DEP_SAMPLE} more — use \`depended_on_by\` if needed)`);
    }
    lines.push("");
  }

  if (bundle.externalDependencies.length > 0) {
    lines.push(`## External dependencies (${bundle.externalDependencies.length})`);
    lines.push(`Sample — call \`depends_on\` on a member file for the full list when naming/framing needs it.`);
    for (const f of bundle.externalDependencies.slice(0, EXTERNAL_DEP_SAMPLE)) lines.push(`- \`${f}\``);
    if (bundle.externalDependencies.length > EXTERNAL_DEP_SAMPLE) {
      lines.push(`- … (+${bundle.externalDependencies.length - EXTERNAL_DEP_SAMPLE} more — use \`depends_on\` if needed)`);
    }
    lines.push("");
  }

  if (bundle.recentCommits.length > 0) {
    lines.push(`## Recent commits`);
    for (const c of bundle.recentCommits) {
      lines.push(`- \`${c.sha.slice(0, 8)}\` (${c.date}) — ${c.message.split("\n")[0]}`);
    }
    lines.push("");
  }

  if (bundle.annotations.length > 0) {
    lines.push(`## Annotations`);
    for (const a of bundle.annotations) {
      lines.push(`- \`${a.file}:${a.line}\` — ${a.note}`);
    }
    lines.push("");
  }

  if (bundle.nearbyDocs.length > 0) {
    lines.push(`## Nearby docs (${bundle.nearbyDocs.length})`);
    lines.push(`Markdown/text sitting next to this community's source — useful for naming and framing. Previews are capped; Read the path for full content.`);
    lines.push("");
    let totalBytes = 0;
    let shown = 0;
    for (const d of bundle.nearbyDocs) {
      if (totalBytes >= MAX_TOTAL_NEARBY_DOC_BYTES) {
        lines.push(`- … (+${bundle.nearbyDocs.length - shown} more — Read the path when relevant)`);
        break;
      }
      const { preview, truncated } = clipDocPreview(d.content, MAX_NEARBY_DOC_BYTES);
      lines.push(`### ${d.path}${truncated ? " (truncated — Read full doc if needed)" : ""}`);
      lines.push("");
      lines.push("```md");
      lines.push(preview);
      lines.push("```");
      lines.push("");
      totalBytes += Buffer.byteLength(preview, "utf-8");
      shown++;
    }
  }

  if (usedSlugs.length > 0) {
    lines.push(`## Slugs already taken`);
    lines.push(`Avoid these exact slugs: ${usedSlugs.map((s) => `\`${s}\``).join(", ")}`);
    lines.push("");
  }

  if (required.length > 0) {
    lines.push(`## REQUIRED sections`);
    lines.push("");
    lines.push(
      "These sections MUST appear in your `sections` array. They are required because the bundle's signals triggered the predicate shown next to each. The section title, purpose, and shape below are authoritative — copy them verbatim. You may reorder, and you may add additional sections from the catalog or of your own, but you may not skip these.",
    );
    lines.push("");
    for (const r of required) {
      lines.push(`### ${r.entry.title} (catalog id: \`${r.entry.id}\`)`);
      lines.push(`**Why required:** ${r.reason}`);
      lines.push(`**Purpose:** ${r.entry.purpose}`);
      lines.push(`**Shape:** ${r.entry.shape}`);
      lines.push(`**Example body:**`);
      lines.push(r.entry.exampleBody);
      lines.push("");
    }
  }

  lines.push(catalogMarkdown);
  lines.push("");
  lines.push(`## Your output`);
  lines.push("");
  lines.push(
    [
      "Call `write_synthesis(communityId, payload)` with the community id above and a payload that matches this shape:",
      "",
      "```json",
      "{",
      '  "name": "<human title>",',
      '  "slug": "<kebab-case, /^[a-z0-9-]+$/, not in used list>",',
      '  "purpose": "<1-2 sentences on what this page is for>",',
      '  "kind": "<free-form category, usually \\"community\\">",',
      '  "sections": [',
      '    { "title": "...", "purpose": "...", "shape": "<copy from catalog when you picked one, omit when custom>" }',
      "  ]",
      "}",
      "```",
      "",
      "Use the catalog as a starting palette. You may adapt catalog entries, combine them, or invent sections the catalog doesn't cover. Do not copy `exampleBody` content — those are illustrations, not templates.",
    ].join("\n"),
  );

  return lines.join("\n");
}

/**
 * Merge required sections into an LLM-returned section list. Required
 * sections missing from the output (by case-insensitive title match) are
 * appended with the catalog entry's title/purpose/shape. This closes the gap
 * when the LLM skips a predicate-matched required section.
 */
export function mergeRequiredSections(
  proposed: import("./types").SectionSpec[],
  required: RequiredSection[],
): { merged: import("./types").SectionSpec[]; injected: string[] } {
  const titles = new Set(proposed.map((s) => s.title.trim().toLowerCase()));
  const injected: string[] = [];
  const merged = [...proposed];
  for (const r of required) {
    const key = r.entry.title.trim().toLowerCase();
    if (titles.has(key)) continue;
    merged.push({
      title: r.entry.title,
      purpose: r.entry.purpose,
      shape: r.entry.shape,
    });
    injected.push(r.entry.id);
  }
  return { merged, injected };
}

/** Validate an LLM-returned payload against the expected shape. */
export function validateSynthesisPayload(
  payload: unknown,
  expectedCommunityId: string,
  usedSlugs: Set<string>,
  required: RequiredSection[] = [],
): { ok: true; value: import("./types").SynthesisPayload; injected: string[] } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "payload must be an object" };
  }
  const p = payload as Record<string, unknown>;
  if (p.communityId !== expectedCommunityId) {
    return { ok: false, error: `communityId mismatch: expected ${expectedCommunityId}` };
  }
  if (typeof p.name !== "string" || !p.name.trim()) {
    return { ok: false, error: "name must be a non-empty string" };
  }
  if (typeof p.slug !== "string" || !/^[a-z0-9-]+$/.test(p.slug)) {
    return { ok: false, error: "slug must match /^[a-z0-9-]+$/" };
  }
  if (usedSlugs.has(p.slug)) {
    return { ok: false, error: `slug "${p.slug}" already taken — pick a different one` };
  }
  if (typeof p.purpose !== "string" || !p.purpose.trim()) {
    return { ok: false, error: "purpose must be a non-empty string" };
  }
  if (!Array.isArray(p.sections) || p.sections.length === 0) {
    return { ok: false, error: "sections must be a non-empty array" };
  }
  const sections: import("./types").SectionSpec[] = [];
  for (let i = 0; i < p.sections.length; i++) {
    const s = p.sections[i] as Record<string, unknown>;
    if (!s || typeof s !== "object") {
      return { ok: false, error: `sections[${i}] must be an object` };
    }
    if (typeof s.title !== "string" || !s.title.trim()) {
      return { ok: false, error: `sections[${i}].title must be a non-empty string` };
    }
    if (typeof s.purpose !== "string" || !s.purpose.trim()) {
      return { ok: false, error: `sections[${i}].purpose must be a non-empty string` };
    }
    if (s.shape !== undefined && typeof s.shape !== "string") {
      return { ok: false, error: `sections[${i}].shape must be a string or omitted` };
    }
    sections.push({
      title: s.title,
      purpose: s.purpose,
      shape: typeof s.shape === "string" ? s.shape : undefined,
    });
  }
  const kind = typeof p.kind === "string" && p.kind.trim() ? p.kind : "community";
  const { merged, injected } = mergeRequiredSections(sections, required);

  return {
    ok: true,
    value: {
      communityId: expectedCommunityId,
      name: p.name,
      slug: p.slug,
      purpose: p.purpose,
      sections: merged,
      kind,
    },
    injected,
  };
}
