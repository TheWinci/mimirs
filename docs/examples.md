# Example tool outputs

Real outputs captured by invoking mimirs tools against this repository. This is what your agent actually receives over MCP — not a UI-prettified summary.

Paths are shown relative to the project root for readability; the tools return absolute paths in practice.

## `search` — find files by meaning

Ranked file paths with score and truncated snippets. Use this when you need to know *where* something is before retrieving content.

**Call:** `search(query: "how are embeddings generated from code chunks", top: 5)`

```
── 6 results across 166 indexed files (6ms) ──

0.7703  src/embeddings/embed.ts

  // ── Tokenizer & embedding merge for oversized chunks ──
  ...

0.6260  src/indexing/chunker.ts

  /**
   * Merge consecutive tiny parts (< minSize chars) to avoid
   * creating embeddings for near-empty chunks....

0.6122  src/indexing/indexer.ts

  /**
   * Build an EmbeddedChunk from a local Chunk + its embedding....

0.3726  README.md
  ## How it works

  1. **Parse & chunk** — Splits content using type-matched strategies: function/class
  boundaries for code (via tree-sitter across 24 languages), headings for markdown,
  top-level keys for YAML/JSON. Chunks that exceed the embedding model's token limit
  are windowed and merged.

  2. **Embed** — Each chunk becomes a 384-dimensional vector using all-MiniLM-L6-v2
  (in-process via Transforme...

0.3643  benchmarks/subchunk-impact.ts

  // ── Chunk analysis (fast, no embedding) ──
  ...

0.3604  benchmarks/indexing-bench-v2.ts
  function buildEmbeddedChunk(
    chunk: any,
    embedding: Float32Array
  ): EmbeddedChunk {
    const primaryExport = chunk.exports?.[0];
    const entityName =
      chunk.parentName && primaryExport?.name
        ? `${chunk.parentName}.${primaryExport.name}`
        : primaryExport?.name ?? null;
    return {
      snippet: chunk.text,
      embedding,
      entityName,
      chunkType: primaryExport?.type ?? null,
     ...

── Tip: call read_relevant with the same query to get full function/class content
   with exact line ranges. ──
```

Hybrid scoring blends vector similarity and BM25 — why the top hit (a tokenizer/merging comment in `embed.ts`) wins over a README section that contains the literal phrase.

## `read_relevant` — retrieve the actual chunks

Full chunk bodies with entity names and exact line ranges. This is what the agent consumes when it needs to reason about code, not just locate it.

**Call:** `read_relevant(query: ""AST chunking"")`

```
[0.70] /Users/winci/repos/mimirs/src/embeddings/embed.ts

// ── Tokenizer & embedding merge for oversized chunks ──


---

[0.65] /Users/winci/repos/mimirs/src/indexing/chunker.ts

/**
 * Split text into chunks. Strategy depends on content type:
 * - Code (supported languages): AST-aware chunking via tree-sitter
 * - Markdown: split on headings first, then by size
 * - Code (unsupported): split on blank-line-separated blocks, then by size
 * - Other: split on paragraphs, then by size

---

[0.63] /Users/winci/repos/mimirs/src/indexing/chunker.ts  •  _chunkText
async function _chunkText(
  text: string,
  extension: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  chunkOverlap = DEFAULT_CHUNK_OVERLAP,
  filePath?: string
): Promise<ChunkTextResult> {
  // Try AST-aware chunking for supported code files (even small ones, for import/export extraction)
  if (AST_SUPPORTED.has(extension)) {
    try {
      const astOpts = { includeContext: true, includeMetadata: true };
      let result;
      if (filePath) {
        try {
          result = await astChunkFile(filePath, astOpts);
        } catch {
          // File may not exist on disk (e.g. tests with inline code) — fall back to text-based AST
          result = await astChunk(`file${extension}`, text, astOpts);
        }
      } else {
        result = await astChunk(`file${extension}`, text, astOpts);
      }

      if (result.chunks.length > 0) {
        const chunks = result.chunks.map((c, i) => {
          const chunk: Chunk = {
            text: c.text,
            index: i,
            startLine: c.startLine + 1, // bun-chunk is 0-indexed, mimirs is 1-indexed
            endLine: c.endLine + 1,
          };
          if (c.imports?.length) chunk.imports = c.imports;
          if (c.exports?.length) chunk.exports = c.exports;
          if (c.parentName) chunk.parentName = c.parentName;
          if (c.name) chunk.name = c.name;
          if (c.type) chunk.chunkType = c.type;
          if (c.hash) chunk.hash = c.hash;
          return chunk;
        });
        return {
          chunks,
          fileImports: result.fileImports,
          fileExports: result.fileExports,
        };
      }
    } catch (err) {
      log.debug(`AST chunking failed for ${filePath || extension}, using heuristic: ${err instanceof Error ? err.message : err}`, "chunker");
    }
  }

  if (text.length <= chunkSize) {
    return { chunks: [{ text, index: 0 }] };
  }

  const isMarkdown = [".md", ".mdx", ".markdown"].includes(extension);
  // Code-like files: split on blank-line-separated blocks as a heuristic.
  // Includes AST-supported languages plus shell, HCL, proto, GraphQL, etc.
  const isCode = AST_SUPPORTED.has(extension) || HEURISTIC_CODE.has(extension);

  let sections: string[];

---

[0.60] /Users/winci/repos/mimirs/src/indexing/chunker.ts

/**
 * Merge consecutive tiny parts (< minSize chars) to avoid
 * creating embeddings for near-empty chunks.

---

[0.60] /Users/winci/repos/mimirs/src/search/hybrid.ts

/**
 * Chunk-level search: returns individual semantic chunks ranked by relevance.
 * No file deduplication — two chunks from the same file can both appear.

---

[0.59] /Users/winci/repos/mimirs/src/indexing/chunker.ts

/**
 * Assign startLine/endLine to each chunk by locating the chunk text in the
 * original file source. Uses indexOf with a forward cursor so overlapping or
 * repeated text still resolves in order. Chunks whose text is not a verbatim
 * substring (e.g. JSON-reformatted chunks) are left without line numbers.

---

[0.59] /Users/winci/repos/mimirs/src/indexing/chunker.ts  •  DEFAULT_CHUNK_SIZE
const DEFAULT_CHUNK_SIZE = 512; // in characters

---

[0.49] /Users/winci/repos/mimirs/src/conversation/indexer.ts

/**
 * Index a single parsed turn: chunk the text, embed chunks, store in DB.

---
```

Each chunk carries `path:start-end` so the agent can cite sources precisely or open a file at the right offset. No file deduplication — multiple chunks from the same file can appear.

## `search_symbols` — find symbols by name

Substring match over every exported function, class, type, interface, and enum in the codebase — faster and more reliable than grep for symbol lookup.

**Call:** `search_symbols(symbol: "chunk", top: 5)`

```
src/indexing/chunker.ts  •  Chunk (interface)
export interface Chunk {
  text: string;
  index: number;
  startLine?: number;
  endLine?: number;
  imports?: ChunkImport[];
  exports?: ChunkExport[];
  parentName?: string;
  /** Symbol name from AST (e.g. "emit", "constructor") — available even without exports */
  name?: string;
  /** AST chun

---

src/search/hybrid.ts  •  ChunkResult (interface)
export interface ChunkResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

---

src/db/types.ts  •  ChunkSearchResult (interface)
export interface ChunkSearchResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

---

src/indexing/chunker.ts  •  ChunkTextResult (interface)
export interface ChunkTextResult {
  chunks: Chunk[];
  fileImports?: ChunkImport[];
  fileExports?: ChunkExport[];
}

---

src/db/types.ts  •  StoredChunk (interface)
export interface StoredChunk {
  id: number;
  fileId: number;
  chunkIndex: number;
  snippet: string;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

── Tip: call find_usages("Chunk") to see all call sites, or read_relevant("Chunk")
   for full context. ──
```

Results include `referenceCount` and `referenceModuleCount` (omitted from display above) — the MCP response lets the agent rank by "most-imported symbol in the codebase", surfacing what's structurally central.

## `find_usages` — the refactoring tool

Every call site and import of a symbol with exact file:line positions. Use before renaming or changing a signature to understand the blast radius.

**Call:** `find_usages(symbol: "searchChunks", top: 10)`

```
Found 10 usages of "searchChunks" across 8 files:

src/db/index.ts
  :478  searchChunks(queryEmbedding: Float32Array, topK?: number, filter?: PathFilter) {

tests/search/read-relevant.test.ts
  :98  describe("searchChunks (read_relevant)", () => {
  :157  const results = await searchChunks("anything", db, 8, 0);
  :2  import { searchChunks } from "../../src/search/hybrid";

tests/search/scoped-search.test.ts
  :112  test("searchChunks honors the extension filter", async () => {

src/cli/commands/search-cmd.ts
  :4  import { search, searchChunks } from "../../search/hybrid";

src/cli/commands/demo.ts
  :5  import { search, searchChunks } from "../../search/hybrid";

benchmarks/parent-promotion-bench.ts
  :24  import { searchChunks, type ChunkResult } from "../src/search/hybrid";

benchmarks/count-grouping-sim.ts
  :13  import { searchChunks, type ChunkResult } from "../src/search/hybrid";

src/tools/search.ts
  :5  import { search, searchChunks } from "../search/hybrid";

── Tip: call depended_on_by("<file>") on any file above to see its full importer tree. ──
```

Handles re-exports and aliased imports that a naive grep would miss.

## `depended_on_by` — file-level blast radius

Reverse-dependency lookup: every file that imports the given file. Useful before modifying a shared module.

**Call:** `depended_on_by(file: "src/search/hybrid.ts")`

```
src/search/hybrid.ts is imported by 20 files:

  benchmarks/parent-promotion-bench.ts  (import: ../src/search/hybrid)
  benchmarks/excalidraw-parent-bench.ts  (import: ../src/search/hybrid)
  benchmarks/quality-bench-worker.ts  (import: ../src/search/hybrid)
  benchmarks/count-grouping-sim.ts  (import: ../src/search/hybrid)
  tests/search/read-relevant.test.ts  (import: ../../src/search/hybrid)
  tests/search/fts-special-chars.test.ts  (import: ../../src/search/hybrid)
  tests/search/search.test.ts  (import: ../../src/search/hybrid)
  tests/search/hybrid-search.test.ts  (import: ../../src/search/hybrid)
  tests/search/scoped-search.test.ts  (import: ../../src/search/hybrid)
  src/search/eval.ts  (import: ./hybrid)
  src/search/benchmark.ts  (import: ./hybrid)
  src/tools/search.ts  (import: ../search/hybrid)
  src/cli/commands/search-cmd.ts  (import: ../../search/hybrid)
  src/cli/commands/demo.ts  (import: ../../search/hybrid)
```

Paired with `find_usages` at symbol-level, this gives the agent complete refactoring context before touching shared code.

---

Full tool reference: [tools.md](tools.md). Configuration options: [configuration.md](configuration.md).
