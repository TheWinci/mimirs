import { relative, resolve, extname, basename } from "path";
import { createHash } from "crypto";
import { readFile, stat, readdir } from "fs/promises";
import { parseFile } from "./parse";
import { embedBatch, embedBatchMerged, mergeEmbeddings } from "../embeddings/embed";
import { chunkText, KNOWN_EXTENSIONS, type ChunkImport, type ChunkExport } from "./chunker";
import { RagDB } from "../db";
import { type RagConfig } from "../config";
import { resolveImports } from "../graph/resolver";
import { log } from "../utils/log";
import { checkIndexDir } from "../utils/dir-guard";
import { normalizePath } from "../utils/path";
import { tryAcquireIndexLock } from "../utils/index-lock";
import { type EmbeddedChunk } from "../types";

function aggregateGraphData(chunks: { imports?: ChunkImport[]; exports?: ChunkExport[] }[]): {
  imports: ChunkImport[];
  exports: ChunkExport[];
} {
  const importMap = new Map<string, ChunkImport>();
  const exportMap = new Map<string, ChunkExport>();

  for (const chunk of chunks) {
    if (chunk.imports) {
      for (const imp of chunk.imports) {
        if (!importMap.has(imp.source)) {
          importMap.set(imp.source, imp);
        }
      }
    }
    if (chunk.exports) {
      for (const exp of chunk.exports) {
        if (!exportMap.has(exp.name)) {
          exportMap.set(exp.name, exp);
        }
      }
    }
  }

  return {
    imports: Array.from(importMap.values()),
    exports: Array.from(exportMap.values()),
  };
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  pruned: number;
  errors: string[];
  locked?: boolean;
  lockReason?: string;
}

function hashString(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Threshold at which we warn the user that the directory may be too broad.
 * We no longer abort — large monorepos can legitimately exceed this count.
 */
const LARGE_PROJECT_WARN_THRESHOLD = 200_000;

/**
 * Build a fast filter from include patterns. Most patterns are either
 * "**‍/*.ext" (extension match) or "**‍/Basename" / "**‍/Basename.*" (basename match).
 * Pre-parsing these avoids creating Glob objects entirely.
 */
export function buildIncludeFilter(patterns: string[]): (rel: string) => boolean {
  const extensions = new Set<string>();
  const basenames = new Set<string>();
  const basenamePrefixes: string[] = [];
  const exactPaths = new Set<string>();
  const rootedExtensions: { prefix: string; extension: string }[] = [];

  for (const p of patterns) {
    const normalized = normalizePath(p);

    const extMatch = p.match(/^\*\*\/\*(\.\w+)$/);
    if (extMatch) { extensions.add(extMatch[1]); continue; }

    const rootedExtMatch = normalized.match(/^(.+)\/\*\*\/\*(\.\w+)$/);
    if (rootedExtMatch) {
      rootedExtensions.push({ prefix: rootedExtMatch[1].replace(/\/+$/, ""), extension: rootedExtMatch[2] });
      continue;
    }

    const baseMatch = normalized.match(/^\*\*\/([^*?/]+)$/);
    if (baseMatch) { basenames.add(baseMatch[1]); continue; }

    const prefixMatch = normalized.match(/^\*\*\/([A-Za-z]\w*)\.\*$/);
    if (prefixMatch) { basenamePrefixes.push(prefixMatch[1] + "."); continue; }

    if (!normalized.includes("*") && !normalized.includes("?")) {
      exactPaths.add(normalized);
      continue;
    }
  }

  return (rel: string) => {
    rel = normalizePath(rel);
    const ext = extname(rel);
    const base = basename(rel);
    return exactPaths.has(rel)
      || extensions.has(ext)
      || basenames.has(base)
      || basenamePrefixes.some((p) => base.startsWith(p))
      || rootedExtensions.some(({ prefix, extension }) =>
        rel.startsWith(prefix + "/") && ext === extension
      );
  };
}

/**
 * Build a fast exclude checker from exclude patterns. Categorises patterns
 * into directory prefixes ("dir/**"), exact basenames (".env"), and
 * basename prefix globs (".env.*", "*.egg-info/**") for fast matching
 * without Glob objects.
 */
export function buildExcludeFilter(patterns: string[]): (rel: string) => boolean {
  /** Prefixes anchored to root (e.g. "src/generated") */
  const anchoredDirPrefixes: string[] = [];
  /** Simple directory names matched anywhere in the path (e.g. "node_modules") */
  const anyDepthDirNames: string[] = [];
  const exactBasenames = new Set<string>();
  const basenamePrefixes: string[] = [];
  const basenameSuffixes: string[] = [];
  // Filename suffixes like "_test.go" matched at any depth
  const filenameSuffixes: string[] = [];

  for (const p of patterns) {
    // "**/dir/**" → explicit any-depth directory match
    const anyDepthDirMatch = p.match(/^\*\*\/([^*?/]+)\/\*\*$/);
    if (anyDepthDirMatch) {
      anyDepthDirNames.push(anyDepthDirMatch[1]);
      continue;
    }

    // "dir/**" → root-anchored directory prefix
    const dirMatch = p.match(/^([^*?]+?)\/?\*\*$/);
    if (dirMatch) {
      anchoredDirPrefixes.push(dirMatch[1]);
      continue;
    }

    // Exact file like ".env"
    if (!p.includes("*") && !p.includes("?") && !p.includes("/")) {
      exactBasenames.add(p); continue;
    }

    // ".env.*" or ".pnp.*" → basename starts with prefix
    const prefixMatch = p.match(/^([^*?/]+)\.\*$/);
    if (prefixMatch) { basenamePrefixes.push(prefixMatch[1] + "."); continue; }

    // "**/*_test.go" or "**/*_generated.go" → filename ends with suffix
    const filenameSuffixMatch = p.match(/^\*\*\/\*([^*?/]+)$/);
    if (filenameSuffixMatch) { filenameSuffixes.push(filenameSuffixMatch[1]); continue; }

    // "*.egg-info/**" → path segment ends with suffix
    const suffixDirMatch = p.match(/^\*([^*?/]+)\/\*\*$/);
    if (suffixDirMatch) { basenameSuffixes.push(suffixDirMatch[1]); continue; }

    // "*.min.js", "*.bundle.js" → filename ends with suffix (any depth)
    const suffixMatch = p.match(/^\*([^*?/]+)$/);
    if (suffixMatch) { filenameSuffixes.push(suffixMatch[1]); continue; }
  }

  return (rel: string) => {
    // Check anchored directory prefixes
    for (const prefix of anchoredDirPrefixes) {
      if (rel.startsWith(prefix + "/") || rel === prefix) return true;
    }

    // Check bare directory names at any depth (e.g. "node_modules", ".git")
    for (const dir of anyDepthDirNames) {
      if (
        rel.startsWith(dir + "/") ||       // root: node_modules/...
        rel.includes("/" + dir + "/") ||    // nested: packages/app/node_modules/...
        rel === dir                          // exact match
      ) return true;
    }

    const base = basename(rel);

    if (exactBasenames.has(base)) return true;

    for (const p of basenamePrefixes) {
      if (base.startsWith(p)) return true;
    }

    for (const s of filenameSuffixes) {
      if (base.endsWith(s)) return true;
    }

    // Check if any path segment matches a suffix pattern (e.g. "foo.egg-info/bar.py")
    if (basenameSuffixes.length > 0) {
      const segments = rel.split("/");
      for (const seg of segments) {
        for (const suffix of basenameSuffixes) {
          if (seg.endsWith(suffix)) return true;
        }
      }
    }

    return false;
  };
}

async function collectFiles(
  directory: string,
  config: RagConfig,
  _onWarning?: (msg: string) => void,
  onProgress?: (msg: string) => void
): Promise<string[]> {
  const isIncluded = buildIncludeFilter(config.include);
  const isExcluded = buildExcludeFilter(config.exclude);

  onProgress?.("scanning files…");

  const allEntries = await readdir(directory, { recursive: true });

  const results: string[] = [];
  let lastReport = 0;

  for (const entry of allEntries) {
    // Normalize Windows backslashes so "/"-based filter logic matches and
    // paths stored downstream use a single canonical separator.
    const rel = normalizePath(entry);
    if (isExcluded(rel)) continue;
    if (!isIncluded(rel)) continue;

    results.push(normalizePath(resolve(directory, rel)));

    const now = Date.now();
    if (now - lastReport >= 500) {
      onProgress?.(`scanning files… ${results.length} found`);
      lastReport = now;
    }
  }

  if (results.length > LARGE_PROJECT_WARN_THRESHOLD) {
    const msg =
      `Warning: found ${results.length.toLocaleString()} indexable files in "${directory}". ` +
      `If this is unintentional, set RAG_PROJECT_DIR to your actual project path in your MCP server config.`;
    _onWarning?.(msg);
    onProgress?.(msg);
  }

  onProgress?.(`scanning files… ${results.length} found`);
  return results;
}

interface ProcessFileOptions {
  config: RagConfig;
  /** Base directory for relative path display */
  baseDir?: string;
  onProgress?: (msg: string, opts?: { transient?: boolean }) => void;
  signal?: AbortSignal;
}

/**
 * Build an EmbeddedChunk from a local Chunk + its embedding.
 */
function buildEmbeddedChunk(chunk: import("./chunker").Chunk, embedding: Float32Array): EmbeddedChunk {
  const primaryExport = chunk.exports?.[0];
  const symbolName = primaryExport?.name ?? chunk.name ?? null;
  const entityName = chunk.parentName && symbolName
    ? `${chunk.parentName}.${symbolName}`
    : symbolName;
  return {
    snippet: chunk.text,
    embedding,
    entityName,
    chunkType: primaryExport?.type ?? chunk.chunkType ?? null,
    startLine: chunk.startLine ?? null,
    endLine: chunk.endLine ?? null,
    contentHash: chunk.hash ?? null,
    references: chunk.references,
  };
}

/**
 * Detect groups of consecutive chunks that belong to the same parent entity.
 * A parent group consists of:
 *  - Bookend chunks: type "class"/"function" with name matching the parent
 *  - Child chunks: chunks with parentName set to the parent
 *
 * Returns groups of ≥2 chunks that share the same parent, with their indices.
 */
interface ParentGroup {
  parentName: string;
  /** Indices into the original chunks array */
  memberIndices: number[];
  /** The chunk type of the bookend (e.g. "class", "function") if found */
  bookendType: string | null;
}

function detectParentGroups(chunks: import("./chunker").Chunk[]): ParentGroup[] {
  const groups = new Map<string, ParentGroup>();

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    let groupName: string | null = null;

    if (c.parentName) {
      // Child chunk (method, field, etc.) or bookend with same name as parent
      groupName = c.parentName;
    } else if (c.exports?.[0]?.name) {
      // Check if this is a bookend: next or prev chunk has parentName matching this export
      const exportName = c.exports[0].name;
      const nextIsChild = chunks[i + 1]?.parentName === exportName;
      const prevIsChild = i > 0 && chunks[i - 1]?.parentName === exportName;
      if (nextIsChild || prevIsChild) {
        groupName = exportName;
      }
    }

    if (!groupName) continue;

    if (!groups.has(groupName)) {
      groups.set(groupName, { parentName: groupName, memberIndices: [], bookendType: null });
    }
    const g = groups.get(groupName)!;
    g.memberIndices.push(i);

    // Track bookend type
    if (c.chunkType && (c.chunkType === "class" || c.chunkType === "function") && c.exports?.[0]?.name === groupName) {
      g.bookendType = c.chunkType;
    }
  }

  // Only return groups with ≥2 members
  return [...groups.values()].filter((g) => g.memberIndices.length >= 2);
}

/**
 * Create parent chunks from detected groups: concatenate text, merge embeddings.
 * Inserts parent chunks into DB and sets parent_id on children.
 */
function createParentChunks(
  groups: ParentGroup[],
  chunks: import("./chunker").Chunk[],
  embeddedChunks: EmbeddedChunk[],
  fileId: number,
  db: RagDB
): void {
  for (const group of groups) {
    const memberEmbeddings = group.memberIndices.map((i) => embeddedChunks[i].embedding);
    const memberTexts = group.memberIndices.map((i) => chunks[i].text);
    const memberStartLines = group.memberIndices.map((i) => chunks[i].startLine).filter((l): l is number => l != null);
    const memberEndLines = group.memberIndices.map((i) => chunks[i].endLine).filter((l): l is number => l != null);

    const parentChunk: EmbeddedChunk = {
      snippet: memberTexts.join("\n\n"),
      embedding: mergeEmbeddings(memberEmbeddings),
      entityName: group.parentName,
      chunkType: group.bookendType ?? "class",
      startLine: memberStartLines.length > 0 ? Math.min(...memberStartLines) : null,
      endLine: memberEndLines.length > 0 ? Math.max(...memberEndLines) : null,
      contentHash: hashString(memberTexts.join("\n\n")),
    };

    // Insert parent, get its id
    // Use chunk_index = -1 to distinguish parent chunks from regular ones
    const parentId = db.insertChunkReturningId(fileId, parentChunk, -1);

    // Update children with parent_id
    for (const idx of group.memberIndices) {
      embeddedChunks[idx].parentId = parentId;
    }
  }
}

/**
 * Shared file processing pipeline: hash → parse → chunk → embed → write to DB.
 * Streams DB writes alongside embedding to cap memory at one batch (~50 chunks)
 * instead of buffering all embeddings.
 *
 * When `config.incrementalChunks` is enabled and the file already has hashed
 * chunks in the DB, only new/changed chunks are re-embedded. Unchanged chunks
 * keep their existing embeddings and just get position updates.
 */
async function processFile(
  filePath: string,
  db: RagDB,
  opts: ProcessFileOptions
): Promise<"indexed" | "skipped"> {
  const { config, baseDir, onProgress, signal } = opts;
  const batchSize = config.indexBatchSize ?? 50;

  // Skip files larger than 50 MB — reading them fully into memory twice
  // (hash + parse) can easily OOM the process. Matches the JSON_PARSE_LIMIT
  // in chunker.ts for consistency.
  const MAX_FILE_SIZE = 50 * 1024 * 1024;
  const fileStat = await stat(filePath);
  if (fileStat.size > MAX_FILE_SIZE) {
    const relPath = baseDir ? relative(baseDir, filePath) : filePath;
    const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);
    onProgress?.(`Skipped (too large, ${sizeMB} MB): ${relPath}`);
    return "skipped";
  }

  // Single read: hash and parse from the same string
  let raw: string | null = await readFile(filePath, "utf-8");
  const hash = hashString(raw);
  const existing = db.getFileByPath(filePath);

  if (existing && existing.hash === hash) {
    onProgress?.(`Skipped (unchanged): ${baseDir ? relative(baseDir, filePath) : filePath}`);
    return "skipped";
  }

  const relPath = baseDir ? relative(baseDir, filePath) : filePath;

  // Detect minified / obfuscated files: extremely long average line length
  // means the file has no meaningful structure for semantic chunking and would
  // explode into tens of thousands of useless character-sliced chunks.
  const MAX_AVG_LINE_LEN = 1000;
  const lineCount = raw.split("\n").length || 1;
  const avgLineLen = raw.length / lineCount;
  if (avgLineLen > MAX_AVG_LINE_LEN) {
    onProgress?.(`Skipped (minified/obfuscated, avg line ${Math.round(avgLineLen)} chars): ${relPath}`);
    return "skipped";
  }

  onProgress?.(`Indexing ${relPath}`);

  const parsed = parseFile(filePath, raw);
  raw = null; // free before the expensive embed loop

  if (!KNOWN_EXTENSIONS.has(parsed.extension)) {
    onProgress?.(`Skipped (unsupported extension "${parsed.extension}"): ${relPath}`);
    return "skipped";
  }

  if (!parsed.content.trim()) {
    onProgress?.(`Skipped (empty): ${relPath}`);
    return "skipped";
  }

  const chunkResult = await chunkText(
    parsed.content,
    parsed.extension,
    config.chunkSize,
    config.chunkOverlap,
    filePath
  );
  const chunks = chunkResult.chunks;

  if (chunks.length > 10000) {
    log.warn(`Large file: ${relPath} produced ${chunks.length} chunks`, "indexer");
  }

  // Try incremental update if enabled and the file already exists with hashed chunks
  const useIncremental = config.incrementalChunks && existing && chunks.every(c => c.hash);
  if (useIncremental) {
    const result = await processFileIncremental(filePath, hash, existing.id, chunks, chunkResult, db, opts);
    if (result !== null) return result;
    // null means incremental wasn't viable (>50% changed) — fall through to full re-index
  }

  // Full re-index: delete all chunks, re-embed, re-insert. The file hash is
  // committed last (see upsertFileStart) so an abort mid-index doesn't strand
  // the file with a matching hash but zero chunks.
  const fileId = db.upsertFileStart(filePath);
  const allEmbedded: EmbeddedChunk[] = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (signal?.aborted) break;

    const batch = chunks.slice(i, i + batchSize);
    const embedFn = config.embeddingMerge !== false ? embedBatchMerged : embedBatch;
    const embeddings = await embedFn(
      batch.map(c => c.text),
      config.indexThreads,
      onProgress ? (msg: string) => onProgress(msg) : undefined,
    );

    for (let j = 0; j < batch.length; j++) {
      allEmbedded.push(buildEmbeddedChunk(batch[j], embeddings[j]));
    }

    onProgress?.(`Embedded ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks for ${relPath}`, { transient: true });
    await Bun.sleep(0);
  }

  if (signal?.aborted) return "skipped";

  // Detect parent groups and create parent chunks before writing children
  const parentGroups = detectParentGroups(chunks);
  if (parentGroups.length > 0) {
    createParentChunks(parentGroups, chunks, allEmbedded, fileId, db);
  }

  // Write all child chunks (now with parent_id set where applicable)
  const DB_BATCH = 500;
  const allChunkIds: number[] = [];
  for (let i = 0; i < allEmbedded.length; i += DB_BATCH) {
    if (signal?.aborted) break;
    const batch = allEmbedded.slice(i, i + DB_BATCH);
    const ids = db.insertChunkBatch(fileId, batch, i);
    allChunkIds.push(...ids);
    onProgress?.(`Writing ${Math.min(i + DB_BATCH, allEmbedded.length)}/${allEmbedded.length} chunks for ${relPath}`, { transient: true });
  }

  // An abort mid-write leaves partial chunks but an empty hash, so the file is
  // retried next run rather than skipped — don't commit the hash here.
  if (signal?.aborted) return "skipped";

  // Store graph metadata — use file-level data from bun-chunk when available
  const graphData = chunkResult.fileImports && chunkResult.fileExports
    ? { imports: chunkResult.fileImports, exports: chunkResult.fileExports }
    : aggregateGraphData(chunks);
  db.upsertFileGraph(fileId, graphData.imports, graphData.exports);

  // Symbol-level references: bun-chunk emits per-chunk identifier maps.
  // Resolution against import scope happens after the project-wide
  // import-resolution pass (`resolveAllSymbolRefs` at end of indexProject).
  const refsToInsert = collectSymbolRefs(allEmbedded, allChunkIds);
  if (refsToInsert.length > 0) db.upsertSymbolRefs(fileId, refsToInsert);

  // Commit the content hash last — only now is the file fully indexed.
  db.updateFileHash(fileId, hash);

  onProgress?.(`Indexed: ${relPath} (${chunks.length} chunks)`);
  return "indexed";
}

/** Flatten per-chunk `references` maps into rows for `symbol_refs` insertion. */
function collectSymbolRefs(
  chunks: EmbeddedChunk[],
  chunkIds: number[]
): { chunkId: number; name: string; line: number }[] {
  const out: { chunkId: number; name: string; line: number }[] = [];
  // chunkIds is parallel to chunks for the leaves we just inserted; parent
  // chunks (created earlier by `createParentChunks`) sit at the front of
  // `allEmbedded` when present, so honor whichever length is shorter.
  const n = Math.min(chunks.length, chunkIds.length);
  for (let i = 0; i < n; i++) {
    const refs = chunks[i].references;
    if (!refs) continue;
    const chunkId = chunkIds[i];
    for (const name in refs) {
      const lines = refs[name];
      for (const line of lines) {
        out.push({ chunkId, name, line });
      }
    }
  }
  return out;
}

/**
 * Incremental chunk update: only re-embed chunks whose content hash changed.
 * Returns null if incremental isn't viable (>50% of chunks changed),
 * signaling the caller to fall through to full re-index.
 */
async function processFileIncremental(
  filePath: string,
  newFileHash: string,
  fileId: number,
  chunks: import("./chunker").Chunk[],
  chunkResult: import("./chunker").ChunkTextResult,
  db: RagDB,
  opts: ProcessFileOptions
): Promise<"indexed" | null> {
  const { config, baseDir, onProgress, signal } = opts;
  const batchSize = config.indexBatchSize ?? 50;
  const relPath = baseDir ? relative(baseDir, filePath) : filePath;

  const oldHashes = db.getChunkHashes(fileId);
  const newHashes = new Set(chunks.map(c => c.hash!));

  // Count how many chunks are new (not in old set)
  let newCount = 0;
  for (const h of newHashes) {
    if (!oldHashes.has(h)) newCount++;
  }

  // If >50% of chunks changed, fall back to full re-index (more efficient)
  if (newCount > chunks.length * 0.5) {
    return null;
  }

  // Files with parent groups (e.g. a class split into method chunks + a parent
  // chunk spanning them) can't be updated incrementally without corruption: the
  // parent's content hash isn't a leaf hash, so deleteStaleChunks would drop it,
  // and the incremental path never rebuilds parents — orphaning the children's
  // parent_id. Rebuilding a parent needs every member's embedding (kept ones
  // live only in the DB), so fall back to a correct full re-index instead.
  if (detectParentGroups(chunks).length > 0) {
    return null;
  }

  onProgress?.(`Incremental update: ${newCount} new, ${chunks.length - newCount} kept for ${relPath}`);

  // 1. Delete stale chunks (old hashes not in new set). The file hash is
  //    committed last (step 5) so a crash mid-update retries instead of leaving
  //    a matching hash with missing chunks.
  const deleted = db.deleteStaleChunks(fileId, newHashes);
  if (deleted > 0) {
    onProgress?.(`Removed ${deleted} stale chunks from ${relPath}`, { transient: true });
  }

  // 2. Update positions of kept chunks
  const positionUpdates: { contentHash: string; chunkIndex: number; startLine: number | null; endLine: number | null }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (oldHashes.has(chunk.hash!)) {
      positionUpdates.push({
        contentHash: chunk.hash!,
        chunkIndex: i,
        startLine: chunk.startLine ?? null,
        endLine: chunk.endLine ?? null,
      });
    }
  }
  if (positionUpdates.length > 0) {
    db.updateChunkPositions(fileId, positionUpdates);
  }

  // 3. Embed and insert only new chunks
  const newChunks = chunks.filter(c => !oldHashes.has(c.hash!));
  for (let i = 0; i < newChunks.length; i += batchSize) {
    if (signal?.aborted) return null;

    const batch = newChunks.slice(i, i + batchSize);
    const embedFn = config.embeddingMerge !== false ? embedBatchMerged : embedBatch;
    const embeddings = await embedFn(
      batch.map(c => c.text),
      config.indexThreads,
      onProgress ? (msg: string) => onProgress(msg) : undefined,
    );

    const embeddedBatch: EmbeddedChunk[] = batch.map((chunk, j) =>
      buildEmbeddedChunk(chunk, embeddings[j])
    );

    // Find the correct chunk_index for each new chunk
    const indexedBatch = embeddedBatch.map((ec, j) => {
      const originalChunk = batch[j];
      const chunkIndex = chunks.indexOf(originalChunk);
      return { ...ec, chunkIndex };
    });

    // Insert with correct indices
    for (const item of indexedBatch) {
      db.insertChunkBatch(fileId, [item], item.chunkIndex);
    }

    onProgress?.(`Embedded ${Math.min(i + batchSize, newChunks.length)}/${newChunks.length} new chunks for ${relPath}`, { transient: true });
  }

  // 4. Update graph metadata
  const graphData = chunkResult.fileImports && chunkResult.fileExports
    ? { imports: chunkResult.fileImports, exports: chunkResult.fileExports }
    : aggregateGraphData(chunks);
  db.upsertFileGraph(fileId, graphData.imports, graphData.exports);

  // Re-emit symbol refs from the freshly parsed chunks. Line numbers in
  // bun-chunk's `references` are absolute-within-file and may have shifted
  // for kept chunks if surrounding content moved. Rewriting wholesale is
  // simpler than partial diff and aligns with the line-number reality of
  // the current file.
  rewriteSymbolRefsByContentHash(db, fileId, chunks);

  // 5. Commit the file hash last — only now is the incremental update complete.
  db.updateFileHash(fileId, newFileHash);

  onProgress?.(`Indexed (incremental): ${relPath} (${newCount} new, ${chunks.length - newCount} kept)`);
  return "indexed";
}

/**
 * Rewrite `symbol_refs` for a file using `content_hash → chunk_id` lookups.
 * Used by the incremental path where we don't have a parallel array of
 * chunk ids — the DB already holds the mix of kept-and-new chunks.
 */
function rewriteSymbolRefsByContentHash(
  db: RagDB,
  fileId: number,
  chunks: import("./chunker").Chunk[]
) {
  const hashToId = db.getChunkIdsByHash(fileId);
  const refs: { chunkId: number; name: string; line: number }[] = [];
  for (const chunk of chunks) {
    if (!chunk.references || !chunk.hash) continue;
    const chunkId = hashToId.get(chunk.hash);
    if (chunkId == null) continue;
    for (const name in chunk.references) {
      for (const line of chunk.references[name]) {
        refs.push({ chunkId, name, line });
      }
    }
  }
  db.upsertSymbolRefs(fileId, refs);
}

/**
 * Index a single file. Returns true if the file was re-indexed, false if skipped.
 */
export async function indexFile(
  filePath: string,
  db: RagDB,
  config: RagConfig
): Promise<"indexed" | "skipped" | "error"> {
  try {
    return await processFile(normalizePath(filePath), db, { config });
  } catch (err) {
    log.warn(`Failed to index ${filePath}: ${err instanceof Error ? err.message : err}`, "indexFile");
    return "error";
  }
}

export async function indexDirectory(
  directory: string,
  db: RagDB,
  config: RagConfig,
  onProgress?: (msg: string, opts?: { transient?: boolean }) => void,
  signal?: AbortSignal,
  options?: { prune?: boolean }
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, pruned: 0, errors: [] };

  if (signal?.aborted) return result;

  // Guard against indexing system-level directories (home, root, etc.)
  const dirCheck = checkIndexDir(directory);
  if (!dirCheck.safe) {
    throw new Error(dirCheck.reason!);
  }

  // Canonicalize the base dir to forward-slashes so relative()/resolve()
  // downstream produce paths that compose cleanly with stored ones.
  directory = normalizePath(directory);

  // Funnel concurrent indexers (multiple IDE windows, CLI overlapping with
  // server) through a process-level lock. Without this, two `processFile`
  // runs for the same file race past each other's deletes and produce 2×
  // chunk rows. Reentrant within this process — server can hold the lock
  // for its lifetime while wrapping its own `indexDirectory` calls.
  const lock = tryAcquireIndexLock(directory);
  if (!lock) {
    const reason = "Another mimirs process owns the index lock for this directory.";
    result.locked = true;
    result.lockReason = reason;
    onProgress?.(`${reason} Skipping indexing in this process.`);
    log.warn(`Skipping indexing: another mimirs process holds the lock for ${directory}`, "indexer");
    return result;
  }

  try {

  const matchedFiles = await collectFiles(directory, config, onProgress, onProgress);

  onProgress?.(`Found ${matchedFiles.length} files to index`);

  // Eagerly load the embedding model so status reflects model-loading before
  // individual file progress begins.
  if (matchedFiles.length > 0) {
    const { getEmbedder } = await import("../embeddings/embed");
    await getEmbedder(config.indexThreads, onProgress);
  }

  for (const filePath of matchedFiles) {
    if (signal?.aborted) break;

    const relPath = relative(directory, filePath);
    onProgress?.(`file:start ${relPath}`);

    try {
      const status = await processFile(filePath, db, {
        config,
        baseDir: directory,
        onProgress,
        signal,
      });

      if (status === "indexed") {
        result.indexed++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      const msg = `Error indexing ${filePath}: ${err instanceof Error ? err.message : err}`;
      result.errors.push(msg);
      onProgress?.(msg);
    }
    onProgress?.(`file:done`);
  }

  if (signal?.aborted) return result;

  if (options?.prune !== false) {
    // Prune files that no longer exist from full-project index runs. Scoped
    // re-indexes must not delete every indexed file outside their include set.
    const existingPaths = new Set(matchedFiles);
    result.pruned = db.pruneDeleted(existingPaths);
    if (result.pruned > 0) {
      onProgress?.(`Pruned ${result.pruned} deleted files from index`);
    }
  }

  // Resolve import paths across all files
  if (result.indexed > 0) {
    const resolved = resolveImports(db, directory);
    if (resolved > 0) {
      onProgress?.(`Resolved ${resolved} import paths`);
    }
    // Symbol-level resolution must follow file-level import resolution —
    // cross-file ref edges depend on `file_imports.resolved_file_id`.
    db.resolveAllSymbolRefs();
  }

  return result;
  } finally {
    lock.release();
  }
}
