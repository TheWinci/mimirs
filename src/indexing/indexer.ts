import { relative } from "path";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { Glob } from "bun";
import { parseFile } from "./parse";
import { embedBatch } from "../embeddings/embed";
import { chunkText, KNOWN_EXTENSIONS, type ChunkImport, type ChunkExport } from "./chunker";
import { RagDB } from "../db";
import { type RagConfig } from "../config";
import { resolveImports, resolveImportsForFile } from "../graph/resolver";

function aggregateGraphData(chunks: { imports?: ChunkImport[]; exports?: ChunkExport[] }[]): {
  imports: { name: string; source: string }[];
  exports: { name: string; type: string }[];
} {
  const importMap = new Map<string, string>(); // source → names
  const exportMap = new Map<string, string>(); // name → type

  for (const chunk of chunks) {
    if (chunk.imports) {
      for (const imp of chunk.imports) {
        if (!importMap.has(imp.source)) {
          importMap.set(imp.source, imp.name);
        }
      }
    }
    if (chunk.exports) {
      for (const exp of chunk.exports) {
        if (!exportMap.has(exp.name)) {
          exportMap.set(exp.name, exp.type);
        }
      }
    }
  }

  return {
    imports: Array.from(importMap, ([source, name]) => ({ name, source })),
    exports: Array.from(exportMap, ([name, type]) => ({ name, type })),
  };
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  pruned: number;
  errors: string[];
}

async function fileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function matchesAny(filePath: string, globs: Glob[]): boolean {
  return globs.some((g) => g.match(filePath));
}

async function collectFiles(
  directory: string,
  config: RagConfig,
  onWarning?: (msg: string) => void
): Promise<string[]> {
  const excludeGlobs = config.exclude.map((pat) => new Glob(pat));

  async function scanPattern(pattern: string): Promise<string[]> {
    const files: string[] = [];
    const glob = new Glob(pattern);
    try {
      for await (const file of glob.scan({ cwd: directory, absolute: true })) {
        const rel = relative(directory, file);
        if (!matchesAny(rel, excludeGlobs)) {
          files.push(file);
        }
      }
    } catch (err: any) {
      if (err.code === "EPERM" || err.code === "EACCES") {
        onWarning?.(`Skipping inaccessible path (${err.code}): ${err.path ?? pattern}`);
      } else {
        throw err;
      }
    }
    return files;
  }

  const results = await Promise.all(config.include.map(scanPattern));

  // Deduplicate (a file might match multiple include patterns)
  return [...new Set(results.flat())];
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
    const hash = await fileHash(filePath);
    const existing = db.getFileByPath(filePath);

    if (existing && existing.hash === hash) {
      return "skipped";
    }

    const parsed = await parseFile(filePath);

    if (!KNOWN_EXTENSIONS.has(parsed.extension)) {
      return "skipped";
    }

    if (!parsed.content.trim()) {
      return "skipped";
    }

    const chunks = await chunkText(
      parsed.content,
      parsed.extension,
      config.chunkSize,
      config.chunkOverlap,
      filePath
    );

    const embeddedChunks: { snippet: string; embedding: Float32Array; entityName?: string | null; chunkType?: string | null; startLine?: number | null; endLine?: number | null }[] = [];
    for (let i = 0; i < chunks.length; i += config.indexBatchSize ?? 50) {
      const batch = chunks.slice(i, i + (config.indexBatchSize ?? 50));
      const embeddings = await embedBatch(batch.map(c => c.text), config.indexThreads);
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const primaryExport = chunk.exports?.[0];
        embeddedChunks.push({
          snippet: chunk.text,
          embedding: embeddings[j],
          entityName: primaryExport?.name ?? null,
          chunkType: primaryExport?.type ?? null,
          startLine: chunk.startLine ?? null,
          endLine: chunk.endLine ?? null,
        });
      }
      await Bun.sleep(0);
    }

    db.upsertFile(filePath, hash, embeddedChunks);

    // Store graph metadata (imports/exports)
    const graphData = aggregateGraphData(chunks);
    const file = db.getFileByPath(filePath);
    if (file) {
      db.upsertFileGraph(file.id, graphData.imports, graphData.exports);
    }

    return "indexed";
  } catch {
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

  const matchedFiles = await collectFiles(directory, config, onProgress);

  onProgress?.(`Found ${matchedFiles.length} files to index`);

  // Index each file
  for (const filePath of matchedFiles) {
    if (signal?.aborted) break;

    try {
      const hash = await fileHash(filePath);
      const existing = db.getFileByPath(filePath);

      if (existing && existing.hash === hash) {
        result.skipped++;
        continue;
      }

      onProgress?.(`Indexing ${relative(directory, filePath)}`);
      const parsed = await parseFile(filePath);

      if (!KNOWN_EXTENSIONS.has(parsed.extension)) {
        onProgress?.(`Skipped (unsupported extension "${parsed.extension}"): ${relative(directory, filePath)}`);
        result.skipped++;
        continue;
      }

      if (!parsed.content.trim()) {
        result.skipped++;
        continue;
      }

      const chunks = await chunkText(
        parsed.content,
        parsed.extension,
        config.chunkSize,
        config.chunkOverlap,
        filePath
      );

      const embeddedChunks: { snippet: string; embedding: Float32Array; entityName?: string | null; chunkType?: string | null; startLine?: number | null; endLine?: number | null }[] = [];
      for (let i = 0; i < chunks.length; i += config.indexBatchSize ?? 50) {
        if (signal?.aborted) break;
        const batch = chunks.slice(i, i + (config.indexBatchSize ?? 50));
        const embeddings = await embedBatch(batch.map(c => c.text), config.indexThreads);
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const primaryExport = chunk.exports?.[0];
          embeddedChunks.push({
            snippet: chunk.text,
            embedding: embeddings[j],
            entityName: primaryExport?.name ?? null,
            chunkType: primaryExport?.type ?? null,
            startLine: chunk.startLine ?? null,
            endLine: chunk.endLine ?? null,
          });
        }
        onProgress?.(`Embedded batch ${Math.min(i + (config.indexBatchSize ?? 50), chunks.length)}/${chunks.length} chunks for ${relative(directory, filePath)}`, { transient: true });
        await Bun.sleep(0);
      }

      if (signal?.aborted) break;

      // Insert into DB in batches, yielding between each to keep the event loop responsive
      const DB_BATCH = 500;
      const fileId = db.upsertFileStart(filePath, hash);
      for (let i = 0; i < embeddedChunks.length; i += DB_BATCH) {
        if (signal?.aborted) break;
        const batch = embeddedChunks.slice(i, i + DB_BATCH);
        db.insertChunkBatch(fileId, batch, i);
        onProgress?.(`Writing batch ${Math.min(i + DB_BATCH, embeddedChunks.length)}/${embeddedChunks.length} chunks to DB for ${relative(directory, filePath)}`, { transient: true });
        await Bun.sleep(0);
      }

      if (signal?.aborted) break;

      // Store graph metadata (imports/exports)
      const graphData = aggregateGraphData(chunks);
      db.upsertFileGraph(fileId, graphData.imports, graphData.exports);

      result.indexed++;
      onProgress?.(`Indexed: ${relative(directory, filePath)} (${chunks.length} chunks)`);
      await Bun.sleep(0);
    } catch (err) {
      const msg = `Error indexing ${filePath}: ${err instanceof Error ? err.message : err}`;
      result.errors.push(msg);
      onProgress?.(msg);
    }
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
