import type { SymbolResult } from "../db/types";

// ─── Graph shapes (parsed from generateProjectMap JSON output) ───

export interface FileLevelNode {
  path: string;
  exports: { name: string; type: string }[];
  fanIn: number;
  fanOut: number;
  isEntryPoint: boolean;
}

export interface FileLevelEdge {
  from: string;
  to: string;
  source: string;
}

export interface FileLevelGraph {
  level: "file";
  nodes: FileLevelNode[];
  edges: FileLevelEdge[];
}

export interface DirectoryEntry {
  path: string;
  fileCount: number;
  files: string[];
  totalExports: number;
  fanIn: number;
  fanOut: number;
}

export interface DirectoryEdge {
  from: string;
  to: string;
  importCount: number;
}

export interface DirectoryLevelGraph {
  level: "directory";
  directories: DirectoryEntry[];
  edges: DirectoryEdge[];
}

// ─── Phase 1: Discovery ───

export interface DiscoveryModule {
  name: string;
  path: string;
  entryFile: string | null;
  files: string[];
  exports: string[];
  fanIn: number;
  fanOut: number;
  internalEdges: number;
  /**
   * Cohesion = actual internal edges / max possible internal edges. Signals
   * how grab-baggy the cluster is; low values mean Louvain grouped weakly
   * connected files, and downstream bundling should trim content to avoid
   * feeding the LLM noise.
   */
  cohesion: number;
  children?: DiscoveryModule[];
}

export interface DiscoveryResult {
  fileCount: number;
  chunkCount: number;
  lastIndexed: string | null;
  modules: DiscoveryModule[];
  graphData: {
    fileLevel: FileLevelGraph;
    directoryLevel: DirectoryLevelGraph;
  };
  warnings: string[];
}

// ─── Phase 2: Categorization ───

export type SymbolTier = "entity" | "bridge";
export type Scope = "cross-cutting" | "shared" | "local";

export interface ClassifiedSymbol {
  name: string;
  type: string; // class, interface, type, enum, function, export
  file: string;
  tier: SymbolTier;
  scope: Scope;
  referenceCount: number;
  referenceModuleCount: number;
  referenceModules: string[];
  hasChildren: boolean;
  childCount: number;
  isReexport: boolean;
  snippet: string | null;
}

export interface ClassifiedFile {
  path: string;
  fanIn: number;
  fanOut: number;
  pageRank: number;        // replaces `isHub` — global PageRank score
  isTopHub: boolean;       // top-K by PageRank (replaces heuristic isHub)
  bridges: string[];
  entities: string[];
}

export interface ClassifiedInventory {
  symbols: ClassifiedSymbol[];
  files: ClassifiedFile[];
  warnings: string[];
}

// ─── Phase 3: Community synthesis (LLM-driven page shaping) ───

/**
 * A community with its pre-gathered bundle. The bundle is everything the LLM
 * needs to name the community and propose page sections — no tool calls from
 * the LLM during synthesis should be required.
 */
export interface CommunityBundle {
  /** Stable id derived from sorted member file list (sha256 prefix). */
  communityId: string;
  /** Sorted member file paths — the community's identity. */
  memberFiles: string[];
  /** Exports from member files, ordered by per-file PageRank descending. */
  exports: { name: string; type: string; file: string; signature: string }[];
  /**
   * Tunables — constant/variable exports with full (non-truncated) initializer
   * snippet. Highlights literal values (multipliers, thresholds, stop-word
   * lists, timeouts) that the synthesis LLM should surface verbatim. Language-
   * agnostic via tree-sitter (bun-chunk emits `"constant"`/`"variable"` for
   * 26 languages).
   */
  tunables: { name: string; type: string; file: string; snippet: string }[];
  /** Max LOC across member files — depth-auto signal. */
  topMemberLoc: number;
  /** Per-member LOC — drives split + bundling decisions in page-tree. */
  memberLoc: Record<string, number>;
  /** Count of tunables (pre-cap) — depth-auto signal. */
  tunableCount: number;
  /**
   * Count of exports (pre-cap). The `exports` array is capped at
   * `MAX_EXPORTS_IN_BUNDLE` (or `MAX_EXPORTS_LOW_COHESION`); this field lets
   * the writer say "shown N of M" when truncated, instead of guessing the
   * community's interface size from the slice.
   */
  exportCount: number;
  /** External files that depend on this community (minus internal edges). */
  externalConsumers: string[];
  /** External files this community depends on (minus internal edges). */
  externalDependencies: string[];
  /**
   * Per-member-file consumer map: member file path → external importers of
   * that file (paths outside the community). Lets sub-page scoping recompute
   * an "external to this sub-page's parent" view without re-querying the DB,
   * and gives writer agents file-attributed importer lists so they don't have
   * to call `depended_on_by` per file.
   */
  consumersByFile: Record<string, string[]>;
  /** Symmetric to `consumersByFile` — member → external dependencies. */
  dependenciesByFile: Record<string, string[]>;
  /** Recent commits touching member files. */
  recentCommits: { sha: string; message: string; date: string; files: string[] }[];
  /** Annotations on member files. */
  annotations: { file: string; line: number; note: string }[];
  /** Highest-PageRank member file — the closest thing to an entry point. */
  topRankedFile: string | null;
  /**
   * First-N-lines previews for every member except `topRankedFile`, sorted
   * by per-file PageRank descending. Lets the writer see imports + top-level
   * signatures of rank 2..N files without issuing follow-up reads. Total
   * byte budget is capped across the set; lowest-rank files drop first.
   */
  memberPreviews: { file: string; firstLines: string; loc: number }[];
  /** Internal PageRank per member file for LLM inspection. */
  pageRank: Record<string, number>;
  /**
   * Cohesion = internal edges / max possible. Low values flag grab-bag
   * clusters; bundles for those are trimmed before the LLM sees them.
   */
  cohesion: number;
  /**
   * Markdown / text files that sit structurally adjacent to this community —
   * attached by path proximity, not graph edges. Gives the LLM narrative
   * context (exemplars, inline docs) the import graph can't capture.
   */
  nearbyDocs: { path: string; content: string }[];
}

/** LLM-produced shape for a community — the "plan" for the page. */
export interface SynthesisPayload {
  /** Must match the community the bundle was built from. */
  communityId: string;
  /** Human-readable page title. */
  name: string;
  /** Kebab-case, path-safe. Matches /^[a-z0-9-]+$/. */
  slug: string;
  /** 1-2 sentence summary used in the index and cross-links. */
  purpose: string;
  /** LLM-proposed page sections. */
  sections: SectionSpec[];
  /** Optional free-form kind label — replaces the old closed `tier` enum. */
  kind?: string;
}

export interface SectionSpec {
  /** H2 title for the section. */
  title: string;
  /** What the section should contain (LLM guidance for step 5). */
  purpose: string;
  /**
   * Structural shape, copied from `SECTION_CATALOG` when the LLM picks an
   * entry. Absent for LLM-invented sections.
   */
  shape?: string;
}

// ─── Phase 4: Page tree (derived from synthesis payloads) ───

export type PageDepth = "full" | "standard" | "brief";

/**
 * A page in the manifest. Community pages are derived from synthesis
 * payloads; aggregate pages (architecture, getting-started) are derived
 * deterministically from discovery.
 */
export interface ManifestPage {
  /** Free-form category: "community" | "architecture" | "getting-started" | or anything the LLM chose. */
  kind: string;
  /** LLM-chosen slug for community pages; fixed slug for aggregates. */
  slug: string;
  title: string;
  /** 1-2 sentence summary — from LLM (community) or static (aggregate). */
  purpose: string;
  /** Sections to write (community pages) or seed structure (aggregates). */
  sections: SectionSpec[];
  depth: PageDepth;
  /** Member files for community pages; empty for aggregates. */
  memberFiles: string[];
  /** Community id; absent for aggregates. */
  communityId?: string;
  /** Other wiki paths this page should link to. */
  relatedPages: string[];
  order: number;
}

export interface PageManifest {
  version: 3;
  generatedAt: string;
  lastGitRef: string;
  pageCount: number;
  pages: Record<string, ManifestPage>;
  warnings: string[];
  cluster?: "files" | "symbols";
}

/** Persistence for synthesis payloads, keyed by community id. */
export interface SynthesesFile {
  version: 1;
  payloads: Record<string, SynthesisPayload>;
  /** Track which member-file sets a given community id was based on. */
  memberSets: Record<string, string[]>;
}

// ─── Per-page content bundle (LLM input for writing, step 5) ───

export interface PageContentCache {
  /** Community bundle (community pages). */
  community?: CommunityBundle;
  /** Architecture-specific bundle (see content-prefetch). */
  architecture?: ArchitectureBundle;
  /** Getting-started-specific bundle. */
  gettingStarted?: GettingStartedBundle;
  /**
   * Pre-run results for the page's `semanticQueries`. Run once during
   * planning so the writer doesn't burn N tool turns calling
   * `read_relevant` itself. Each writer cache replay is the full system
   * prompt — eliminating those turns is a wall-time + cost win.
   *
   * Hits are content-bearing snippets (top-K per query, capped per chunk
   * to keep payload bounded). The writer is told the queries are pre-run
   * and to call `read_relevant` only when a section needs an angle the
   * pre-run missed.
   */
  prefetchedQueries?: { query: string; results: PrefetchedQueryHit[] }[];
}

/** One pre-run semantic-query hit. Snippet is byte-capped at build time. */
export interface PrefetchedQueryHit {
  path: string;
  startLine: number | null;
  endLine: number | null;
  entityName: string | null;
  chunkType: string | null;
  score: number;
  /** Snippet (first N lines) of the chunk. Capped per `PREFETCH_SNIPPET_LINES`. */
  snippet: string;
}

/**
 * Path-only doc reference with a small preview so the LLM can decide whether
 * to Read the full file. Replaces shipping verbatim content in bundles for
 * anything that can be large (READMEs, ADRs, design notes).
 */
export interface DocPreview {
  path: string;
  byteSize: number;
  /** First ~10 lines of the file, untrimmed from the start. */
  firstLines: string;
}

export interface ArchitectureBundle {
  /** Every community's { slug, name, purpose, memberFiles }. */
  communities: { slug: string; name: string; purpose: string; memberFiles: string[] }[];
  /** Community-level meta-graph edges (who imports whom). */
  metaEdges: { from: string; to: string; weight: number }[];
  /** PageRank over the community meta-graph. */
  communityPageRank: Record<string, number>;
  /**
   * Top-K load-bearing files by global PageRank — replaces `isHub`.
   *
   * `importingCommunities` lists the community slugs that reach this hub
   * through the file-level import graph. Gives the writer a ready
   * narrative sentence ("imported by N of M communities") instead of a
   * raw fan-in number that reads as trivia. Communities that contain the
   * hub itself are excluded from the list.
   */
  topHubs: {
    path: string;
    pageRank: number;
    /**
     * Raw call-graph counts, surfaced alongside PageRank because they're
     * citable integers (`embed.ts is imported by 77 files`) — readers can
     * reproduce them with `depended_on_by`/`depends_on`, while PageRank
     * scores aren't directly comparable. Together they give writers both a
     * ranking signal (PR) and a verifiable claim (fanIn/fanOut).
     */
    fanIn: number;
    fanOut: number;
    bridges: string[];
    importingCommunities: string[];
  }[];
  /** Files with fanIn === 0 (graph sinks / true entry points). */
  entryPoints: { path: string; exports: { name: string; type: string }[] }[];
  /**
   * High-fanIn files that Louvain excludes (test fixtures, benchmark helpers).
   * These don't get their own wiki community but are load-bearing in practice
   * — surfacing them prevents the architecture page from hiding real coupling.
   * Sorted by fanIn descending, capped at 10.
   */
  crossCuttingFiles: {
    path: string;
    fanIn: number;
    fanOut: number;
    reason: "test-fixture";
  }[];
  /**
   * Repo-root markdown (README, ARCHITECTURE, ADRs) — path + preview only.
   * Full content stays on disk; the writer LLM calls Read when a preview
   * looks relevant. Shipping full content inflates the architecture payload
   * past token limits (a real bug we hit in practice).
   */
  rootDocs: DocPreview[];
  /** Annotations tagged as architectural. */
  architecturalNotes: { file: string; line: number; note: string }[];
  /**
   * Markdown / text isolates that didn't path-match any community — repo-wide
   * docs, design notes, etc. Distinct from `rootDocs` which pulls a fixed
   * allowlist (README/ARCHITECTURE/ADRs). Same path+preview discipline.
   */
  supplementaryDocs: DocPreview[];
}

export interface GettingStartedBundle {
  /** README verbatim if present. */
  readme: string | null;
  /** package.json (or equivalent) parsed. */
  packageManifest: unknown | null;
  /** Top community — "the thing the user is actually using". */
  topCommunity: { slug: string; name: string; purpose: string } | null;
  /** CLI entry point candidates — files isEntryPoint with CLI-ish names. */
  cliEntryPoints: { path: string; exports: { name: string; type: string }[] }[];
  /** Env/config files at repo root. */
  configFiles: { path: string; content: string }[];
  /** First + milestone commits for project origin. */
  originCommits: { sha: string; message: string; date: string }[];
}

export type ContentCache = Record<string, PageContentCache>;

// ─── Step-5 page payload (returned by generate_wiki(page: N)) ───

export interface PagePayload {
  wikiPath: string;
  kind: string;
  slug: string;
  title: string;
  purpose: string;
  depth: PageDepth;
  sections: SectionSpec[];
  prefetched: PageContentCache;
  relatedPages: string[];
  linkMap: Record<string, string>;
  /**
   * Git ref the manifest was built against. Emitted as a per-page stamp below
   * the H1 so readers can tell at a glance whether the page matches HEAD.
   */
  generatedFrom: string;
  /**
   * Parent pages from architecture root down to (but not including) this page.
   * Empty for root-level pages (architecture, index, getting-started). Used
   * by the writer to emit a breadcrumb trail at the top of sub-pages.
   */
  breadcrumbs: { title: string; relPath: string }[];
  /**
   * Kind-specific semantic queries the writer should run with `read_relevant`
   * before drafting sections. Sharpens prefetch on dimensions the bundle may
   * have missed (error paths, internal constants, call sites, etc.).
   */
  semanticQueries: string[];
  /**
   * Pre-run results for `semanticQueries`, shipped inline so the writer
   * skips the corresponding `read_relevant` calls. Hydrated from the
   * page's content cache.
   */
  prefetchedQueries: { query: string; results: PrefetchedQueryHit[] }[];
  /**
   * Markdown blocks the writer copies verbatim into the page. Pre-rendering
   * removes the chance that a writer forgets to author the breadcrumb or a
   * "See also" section — 0/12 community pages grew a See also block in the
   * v2 run when the guidance lived only in prose rules.
   *
   * `breadcrumb`: the `> [Parent](..) › [Grand](..)` trail for sub-pages.
   * Empty string on top-level pages.
   *
   * `seeAlso`: the full `## See also` block (heading + bulleted list of
   * related pages, link titles resolved from the manifest). Empty string
   * when there are no related pages.
   */
  preRendered: {
    breadcrumb: string;
    seeAlso: string;
  };
}

// ─── Orchestrator result ───

export interface WikiPlanResult {
  discovery: DiscoveryResult;
  classified: ClassifiedInventory;
  manifest: PageManifest;
  content: ContentCache;
  syntheses: SynthesesFile;
  warnings: string[];
}

// ─── Pre-regen snapshot (LLM update-log narration) ───

/**
 * One entry per page that was flagged stale or added at planning time.
 * Captures the *old* on-disk content so finalize can diff against the new
 * content the writers produced. `oldContent` is null for newly-added pages
 * (no prior version to diff).
 */
export interface PreRegenSnapshotPage {
  title: string;
  kind: string;
  depth: PageDepth;
  /** Files (or events like `community set changed`) that flagged this page. */
  triggers: string[];
  /** Full markdown body of the prior page, or null for added pages. */
  oldContent: string | null;
}

export interface PreRegenSnapshot {
  version: 1;
  sinceRef: string;
  newRef: string;
  capturedAt: string;
  /** Commit subjects in the `sinceRef..newRef` window. */
  commits: { hash: string; message: string }[];
  /** Pages that were removed entirely — name only, no diff. */
  removed: { wikiPath: string; title: string }[];
  /** Stale + added pages keyed by wiki path. */
  pages: Record<string, PreRegenSnapshotPage>;
}

/** Per-page structural diff fed to the narrative LLM as grounding. */
export interface PageDiff {
  wikiPath: string;
  title: string;
  kind: string;
  /** "added" when there was no prior content. */
  status: "stale" | "added";
  triggers: string[];
  sectionsAdded: string[];
  sectionsRemoved: string[];
  sectionsRewritten: string[];
  citationsAdded: string[];
  citationsRemoved: string[];
  mermaidDelta: { oldCount: number; newCount: number; oldTypes: string[]; newTypes: string[] };
  numericLiteralsAdded: string[];
  numericLiteralsRemoved: string[];
  /** Byte-size delta for cheap "tightened/expanded" signal. */
  byteDelta: number;
}
