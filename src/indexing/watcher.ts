import { watch } from "fs";
import { resolve, relative, basename } from "path";
import { existsSync } from "fs";
import { indexFile, buildIncludeFilter, buildExcludeFilter } from "./indexer";
import { type RagConfig } from "../config";
import { type RagDB } from "../db";
import { resolveImportsForFile, buildPathToIdMap, buildIdToPathMap } from "../graph/resolver";
import { normalizePath } from "../utils/path";

const DEBOUNCE_MS = 2000;

export interface Watcher {
  close(): void;
}

export function startWatcher(
  directory: string,
  db: RagDB,
  config: RagConfig,
  onEvent?: (msg: string) => void
): Watcher {
  const pending = new Map<string, NodeJS.Timeout>();

  // SAME filters as the scan path — the watcher used to compile raw Globs,
  // which disagreed with the scan's pattern semantics for suffix shapes
  // (`*.min.js` is any-depth in the scan, root-only as a raw Glob), so the
  // watcher indexed files the next startup scan pruned: an oscillating index.
  const isExcluded = buildExcludeFilter(config.exclude);
  const isIncluded = buildIncludeFilter(config.include);

  // Serial queue: prevents concurrent indexFile + buildPathToIdMap from interleaving.
  // While one cycle runs, new files accumulate in nextBatch and get processed next.
  let processing = false;
  const nextBatch = new Map<string, "index" | "remove">();

  async function processQueue() {
    if (processing) return;
    processing = true;

    try {
      while (nextBatch.size > 0) {
        // Snapshot and clear the batch so new events accumulate into a fresh batch
        const batch = new Map(nextBatch);
        nextBatch.clear();

        for (const [absPath, action] of batch) {
          const rel = relative(directory, absPath);

          // Per-file isolation: a transient failure (e.g. SQLITE_BUSY) must not
          // abort the rest of the batch or reject processQueue — an unhandled
          // rejection escalates to the server's handler and exits the process,
          // tearing down every project it serves.
          try {
            if (action === "remove") {
              const removed = db.removeFile(absPath);
              if (removed) onEvent?.(`Removed deleted file: ${rel}`);
              continue;
            }

            const result = await indexFile(absPath, db, config);
            if (result === "indexed") {
              const file = db.getFileByPath(absPath);
              if (file) {
                // Build lookups once and reuse for all resolve calls.
                // Safe because the queue ensures no concurrent indexFile is running.
                const pathToId = buildPathToIdMap(db);
                const idToPath = buildIdToPathMap(pathToId);
                resolveImportsForFile(db, file.id, directory, pathToId, idToPath);
                db.resolveSymbolRefs(file.id);
                const reResolved = new Set<number>([file.id]);
                for (const importerId of db.getImportersOf(file.id)) {
                  resolveImportsForFile(db, importerId, directory, pathToId, idToPath);
                  db.resolveSymbolRefs(importerId);
                  reResolved.add(importerId);
                }
                // getImportersOf only finds files whose import already RESOLVED
                // to this file. Files holding an unresolved import that targets
                // the newly created path (delete→recreate, branch switch, module
                // added to fix a missing import) were never revisited, leaving
                // dependents/impact/trace edges missing until a full re-index.
                // Re-resolve files whose unresolved specifier names this file.
                const fileBase = basename(absPath);
                const fileStem = fileBase.replace(/\.[^.]+$/, "");
                for (const ui of db.getUnresolvedImports()) {
                  if (reResolved.has(ui.fileId)) continue;
                  const lastSeg = ui.source.split("/").pop() ?? ui.source;
                  const lastStem = lastSeg.replace(/\.[^.]+$/, "");
                  if (lastSeg === fileBase || lastStem === fileStem) {
                    resolveImportsForFile(db, ui.fileId, directory, pathToId, idToPath);
                    db.resolveSymbolRefs(ui.fileId);
                    reResolved.add(ui.fileId);
                  }
                }
              }
              onEvent?.(`Re-indexed: ${rel}`);
            }
          } catch (err) {
            onEvent?.(`Watch update failed for ${rel}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    } finally {
      processing = false;
    }
  }

  const fsWatcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (!filename) return;

    // Normalize separators (fs.watch yields backslashes on Windows) so the
    // globs match the same way the full indexer's filter does — otherwise the
    // watcher would index excluded dirs (e.g. node_modules) the full scan skips.
    const rel = normalizePath(filename.toString());

    if (isExcluded(rel)) return;
    if (!isIncluded(rel)) return;

    const absPath = resolve(directory, rel);

    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);

    pending.set(
      absPath,
      setTimeout(() => {
        pending.delete(absPath);

        if (!existsSync(absPath)) {
          nextBatch.set(absPath, "remove");
        } else {
          nextBatch.set(absPath, "index");
        }

        // Defensive: processQueue isolates per-file errors, but never let the
        // unawaited promise reject (would become an unhandledRejection).
        processQueue().catch(() => {});
      }, DEBOUNCE_MS)
    );
  });

  onEvent?.(`Watching ${directory} for changes`);
  return {
    close() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      fsWatcher.close();
    },
  };
}
