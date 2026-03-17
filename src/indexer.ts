import { relative } from "path";
import { createHash } from "crypto";
import { readFile } from "fs/promises";
import { Glob } from "bun";
import { parseFile } from "./parse";
import { embed } from "./embed";
import { chunkText, type ChunkImport, type ChunkExport } from "./chunker";
import { RagDB } from "./db";
import { type RagConfig } from "./config";
import { resolveImports, resolveImportsForFile } from "./graph";

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

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pat) => new Glob(pat).match(filePath));
}

async function collectFiles(
  directory: string,
  config: RagConfig
): Promise<string[]> {
  const matched: string[] = [];

  for (const pattern of config.include) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: directory, absolute: true })) {
      const rel = relative(directory, file);
      if (!matchesAny(rel, config.exclude)) {
        matched.push(file);
      }
    }
  }

  // Deduplicate (a file might match multiple include patterns)
  return [...new Set(matched)];
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

    const embeddedChunks: { snippet: string; embedding: Float32Array }[] = [];
    for (const chunk of chunks) {
      const embedding = await embed(chunk.text);
      embeddedChunks.push({ snippet: chunk.text, embedding });
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
  onProgress?: (msg: string) => void
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, skipped: 0, pruned: 0, errors: [] };

  const matchedFiles = await collectFiles(directory, config);

  onProgress?.(`Found ${matchedFiles.length} files to index`);

  // Index each file
  for (const filePath of matchedFiles) {
    try {
      const hash = await fileHash(filePath);
      const existing = db.getFileByPath(filePath);

      if (existing && existing.hash === hash) {
        result.skipped++;
        continue;
      }

      const parsed = await parseFile(filePath);

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

      const embeddedChunks: { snippet: string; embedding: Float32Array }[] = [];
      for (const chunk of chunks) {
        const embedding = await embed(chunk.text);
        embeddedChunks.push({ snippet: chunk.text, embedding });
      }

      db.upsertFile(filePath, hash, embeddedChunks);

      // Store graph metadata (imports/exports)
      const graphData = aggregateGraphData(chunks);
      const file = db.getFileByPath(filePath);
      if (file) {
        db.upsertFileGraph(file.id, graphData.imports, graphData.exports);
      }

      result.indexed++;
      onProgress?.(`Indexed: ${relative(directory, filePath)} (${chunks.length} chunks)`);
    } catch (err) {
      const msg = `Error indexing ${filePath}: ${err instanceof Error ? err.message : err}`;
      result.errors.push(msg);
      onProgress?.(msg);
    }
  }

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
