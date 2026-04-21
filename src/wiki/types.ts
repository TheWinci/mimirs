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

export type HubPath = "A" | "B";

export interface ClassifiedFile {
  path: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  hubPath?: HubPath;
  bridges: string[];
  entities: string[];
}

export interface ClassifiedModule {
  name: string;
  path: string;
  entryFile: string | null;
  files: string[];
  qualifiesAsModulePage: boolean;
  reason: string;
  hubs: string[]; // file paths
  bridges: string[]; // symbol names
  entityCount: number;
  fileCount: number;
  exportCount: number;
  fanIn: number;
  fanOut: number;
  value: number;
}

export interface ClassifiedInventory {
  symbols: ClassifiedSymbol[];
  files: ClassifiedFile[];
  modules: ClassifiedModule[];
  warnings: string[];
}

// ─── Phase 3: Page Tree ───

export type PageDepth = "full" | "standard" | "brief";

/** Structural shape of a page. Coarser than the old PageType — focus discriminates the aggregates. */
export type PageKind = "module" | "file" | "aggregate";

/** Discriminator for aggregate pages. Also used by file-kind pages (always "module-file"). */
export type PageFocus =
  | "module-file"
  | "architecture"
  | "data-flows"
  | "getting-started"
  | "conventions"
  | "testing"
  | "index";

export interface ManifestPage {
  kind: PageKind;
  /** Further discriminator. Required for aggregate; "module-file" for file kind; omitted for module kind. */
  focus?: PageFocus;
  tier: "module" | "aggregate";
  title: string;
  depth: PageDepth;
  sourceFiles: string[];
  relatedPages: string[];
  order: number; // position in the generation sequence
}

export interface PageManifest {
  version: 2;
  generatedAt: string;
  lastGitRef: string;
  pageCount: number;
  pages: Record<string, ManifestPage>; // wiki path → page info
  warnings: string[];
  /** Clustering strategy used for module discovery. Defaults to "files". */
  cluster?: "files" | "symbols";
}

// ─── Phase 4: Content Pre-fetch ───

export interface PageContentCache {
  // Structural data (from graph/DB queries)
  exports?: { name: string; type: string; signature: string }[];
  dependencies?: string[];
  dependents?: string[];
  fanIn?: number;
  fanOut?: number;
  usageSites?: { path: string; line: number }[];
  neighborhood?: object;

  // Semantic data (pre-extracted)
  overview?: string;
  relevantChunks?: string[];

  // Children
  children?: string[];
  files?: string[];
  inlineChildren?: ClassifiedSymbol[];

  // Cross-cutting page data
  modules?: { name: string; fileCount: number; exportCount: number; fanIn: number; fanOut: number; entryFile: string | null }[];
  hubs?: { path: string; fanIn: number; fanOut: number; bridges: string[] }[];
  entryPoints?: { path: string; exports: { name: string; type: string }[] }[];
  crossCuttingSymbols?: { name: string; type: string; file: string; referenceModuleCount: number; referenceModules: string[] }[];
  testFiles?: string[];
}

export type ContentCache = Record<string, PageContentCache>;

// ─── Page Payload (returned by generate_wiki(page: N)) ───

export interface SemanticQuery {
  query: string;
  top: number;
  reason: string;
}

export interface ToolBreadcrumb {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface CandidateSection {
  /** Stable section identifier (matches the filename without extension). */
  name: string;
  /** Why this section was matched or filtered out. */
  reason: string;
  /** Whether the section's predicate fires for this page's prefetched data. */
  matched: boolean;
  /** The example markdown body (front-matter stripped). */
  exampleBody: string;
}

export interface PagePayload {
  wikiPath: string;
  kind: PageKind;
  focus?: PageFocus;
  depth: PageDepth;
  title: string;
  /** Aggregate-page exemplar path (full example page). Omitted for module/file kinds. */
  exemplarPath?: string;
  sourceFile: string;
  prefetched: PageContentCache;
  /** Section library candidates, filtered by kind/focus, ranked by match. */
  candidateSections: CandidateSection[];
  semanticQueries: SemanticQuery[];
  relatedPages: string[];
  additionalTools: ToolBreadcrumb[];
  /** Maps page title → relative markdown link from this page's directory */
  linkMap: Record<string, string>;
}

// ─── Orchestrator result ───

export interface WikiPlanResult {
  discovery: DiscoveryResult;
  classified: ClassifiedInventory;
  manifest: PageManifest;
  content: ContentCache;
  warnings: string[];
}
