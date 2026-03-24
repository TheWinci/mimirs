import { relative, resolve, extname, basename } from "path";
import { createHash } from "crypto";
import { readFile, stat, readdir } from "fs/promises";
import { parseFile } from "./parse";
import { embedBatch } from "../embeddings/embed";
import { chunkText, KNOWN_EXTENSIONS, type ChunkImport, type ChunkExport } from "./chunker";
import { RagDB } from "../db";
import { type RagConfig } from "../config";
import { resolveImports } from "../graph/resolver";
import { log } from "../utils/log";
import { checkIndexDir } from "../utils/dir-guard";
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
}

function hashString(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Hard cap on files to collect. Prevents OOM when the project directory
 * accidentally resolves to ~ or / and glob starts walking the entire FS.
 * 100 000 source files is already a very large monorepo — anything beyond
 * that almost certainly means the directory is wrong.
 */
const MAX_COLLECT_FILES = 100_000;

/**
 * Build a fast filter from include patterns. Most patterns are either
 * "**‍/*.ext" (extension match) or "**‍/Basename" / "**‍/Basename.*" (basename match).
 * Pre-parsing these avoids creating Glob objects entirely.
 */
function buildIncludeFilter(patterns: string[]): (rel: string) => boolean {
  const extensions = new Set<string>();
  const basenames = new Set<string>();
  const basenamePrefixes: string[] = [];

  for (const p of patterns) {
    const extMatch = p.match(/^\*\*\/\*(\.\w+)$/);
    if (extMatch) { extensions.add(extMatch[1]); continue; }

    const baseMatch = p.match(/^\*\*\/([A-Za-z]\w*)$/);
    if (baseMatch) { basenames.add(baseMatch[1]); continue; }

    const prefixMatch = p.match(/^\*\*\/([A-Za-z]\w*)\.\*$/);
    if (prefixMatch) { basenamePrefixes.push(prefixMatch[1] + "."); continue; }
  }

  return (rel: string) => {
    const ext = extname(rel);
    const base = basename(rel);
    return extensions.has(ext)
      || basenames.has(base)
      || basenamePrefixes.some((p) => base.startsWith(p));
  };
}

/**
 * Build a fast exclude checker from exclude patterns. Categorises patterns
 * into directory prefixes ("dir/**"), exact basenames (".env"), and
 * basename prefix globs (".env.*", "*.egg-info/**") for fast matching
 * without Glob objects.
 */
function buildExcludeFilter(patterns: string[]): (rel: string) => boolean {
  const dirPrefixes: string[] = [];
  const exactBasenames = new Set<string>();
  const basenamePrefixes: string[] = [];
  const basenameSuffixes: string[] = [];

  for (const p of patterns) {
    // "dir/**" or "dir" → directory prefix
    const dirMatch = p.match(/^([^*?]+?)\/?\*\*$/);
    if (dirMatch) { dirPrefixes.push(dirMatch[1]); continue; }

    // Exact file like ".env"
    if (!p.includes("*") && !p.includes("?") && !p.includes("/")) {
      exactBasenames.add(p); continue;
    }

    // ".env.*" or ".pnp.*" → basename starts with prefix
    const prefixMatch = p.match(/^([^*?/]+)\.\*$/);
    if (prefixMatch) { basenamePrefixes.push(prefixMatch[1] + "."); continue; }

    // "*.egg-info/**" → path segment ends with suffix
    const suffixDirMatch = p.match(/^\*([^*?/]+)\/\*\*$/);
    if (suffixDirMatch) { basenameSuffixes.push(suffixDirMatch[1]); continue; }
  }

  return (rel: string) => {
    // Check directory prefixes (most common case)
    for (const prefix of dirPrefixes) {
      if (rel.startsWith(prefix + "/") || rel === prefix) return true;
    }

    const base = basename(rel);

    if (exactBasenames.has(base)) return true;

    for (const p of basenamePrefixes) {
      if (base.startsWith(p)) return true;
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

  if (allEntries.length > MAX_COLLECT_FILES) {
    throw new Error(
      `Aborting: found more than ${MAX_COLLECT_FILES.toLocaleString()} filesystem entries in "${directory}". ` +
      `This usually means RAG_PROJECT_DIR is not set and the server defaulted to your home folder or another broad directory. ` +
      `Set RAG_PROJECT_DIR to your actual project path in your MCP server config.`
    );
  }

  const results: string[] = [];
  let lastReport = 0;

  for (const rel of allEntries) {
    if (isExcluded(rel)) continue;
    if (!isIncluded(rel)) continue;

    results.push(resolve(directory, rel));

    const now = Date.now();
    if (now - lastReport >= 500) {
      onProgress?.(`scanning files… ${results.length} found`);
      lastReport = now;
    }
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
  const entityName = chunk.parentName && primaryExport?.name
    ? `${chunk.parentName}.${primaryExport.name}`
    : primaryExport?.name ?? null;
  return {
    snippet: chunk.text,
    embedding,
    entityName,
    chunkType: primaryExport?.type ?? null,
    startLine: chunk.startLine ?? null,
    endLine: chunk.endLine ?? null,
    contentHash: chunk.hash ?? null,
  };
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

  // Full re-index: delete all chunks, re-embed, re-insert
  const DB_BATCH = 500;
  const fileId = db.upsertFileStart(filePath, hash);
  let chunkOffset = 0;
  let pendingDbChunks: EmbeddedChunk[] = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (signal?.aborted) break;

    const batch = chunks.slice(i, i + batchSize);
    const embeddings = await embedBatch(
      batch.map(c => c.text),
      config.indexThreads,
      onProgress ? (msg: string) => onProgress(msg) : undefined,
    );

    for (let j = 0; j < batch.length; j++) {
      pendingDbChunks.push(buildEmbeddedChunk(batch[j], embeddings[j]));
    }

    // Flush to DB when we hit DB_BATCH size or on last iteration
    if (pendingDbChunks.length >= DB_BATCH || i + batchSize >= chunks.length) {
      if (signal?.aborted) break;
      db.insertChunkBatch(fileId, pendingDbChunks, chunkOffset);
      onProgress?.(`Writing ${Math.min(chunkOffset + pendingDbChunks.length, chunks.length)}/${chunks.length} chunks for ${relPath}`, { transient: true });
      chunkOffset += pendingDbChunks.length;
      pendingDbChunks = [];
      await Bun.sleep(0);
    }
  }

  if (signal?.aborted) return "skipped";

  // Store graph metadata — use file-level data from bun-chunk when available
  const graphData = chunkResult.fileImports && chunkResult.fileExports
    ? { imports: chunkResult.fileImports, exports: chunkResult.fileExports }
    : aggregateGraphData(chunks);
  db.upsertFileGraph(fileId, graphData.imports, graphData.exports);

  onProgress?.(`Indexed: ${relPath} (${chunks.length} chunks)`);
  return "indexed";
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

  onProgress?.(`Incremental update: ${newCount} new, ${chunks.length - newCount} kept for ${relPath}`);

  // 1. Update file hash (without deleting chunks)
  db.updateFileHash(fileId, newFileHash);

  // 2. Delete stale chunks (old hashes not in new set)
  const deleted = db.deleteStaleChunks(fileId, newHashes);
  if (deleted > 0) {
    onProgress?.(`Removed ${deleted} stale chunks from ${relPath}`, { transient: true });
  }

  // 3. Update positions of kept chunks
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

  // 4. Embed and insert only new chunks
  const newChunks = chunks.filter(c => !oldHashes.has(c.hash!));
  for (let i = 0; i < newChunks.length; i += batchSize) {
    if (signal?.aborted) return null;

    const batch = newChunks.slice(i, i + batchSize);
    const embeddings = await embedBatch(
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

  // 5. Update graph metadata
  const graphData = chunkResult.fileImports && chunkResult.fileExports
    ? { imports: chunkResult.fileImports, exports: chunkResult.fileExports }
    : aggregateGraphData(chunks);
  db.upsertFileGraph(fileId, graphData.imports, graphData.exports);

  onProgress?.(`Indexed (incremental): ${relPath} (${newCount} new, ${chunks.length - newCount} kept)`);
  return "indexed";
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
    return await processFile(filePath, db, { config });
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
  signal?: AbortSignal
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, pruned: 0, errors: [] };

  if (signal?.aborted) return result;

  // Guard against indexing system-level directories (home, root, etc.)
  const dirCheck = checkIndexDir(directory);
  if (!dirCheck.safe) {
    throw new Error(dirCheck.reason!);
  }

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

  // Prune files that no longer exist
  const existingPaths = new Set(matchedFiles);
  result.pruned = db.pruneDeleted(existingPaths);
  if (result.pruned > 0) {
    onProgress?.(`Pruned ${result.pruned} deleted files from index`);
  }

  // Resolve import paths across all files
  if (result.indexed > 0) {
    const resolved = resolveImports(db, directory);
    if (resolved > 0) {
      onProgress?.(`Resolved ${resolved} import paths`);
    }
  }

  return result;
}
