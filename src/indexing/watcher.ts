import { watch } from "fs";
import { resolve, relative } from "path";
import { existsSync } from "fs";
import { Glob } from "bun";
import { indexFile } from "./indexer";
import { type RagConfig } from "../config";
import { type RagDB } from "../db";
import { resolveImportsForFile, buildPathToIdMap, buildIdToPathMap } from "../graph/resolver";

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

  // Pre-compile globs once instead of per-event
  const excludeGlobs = config.exclude.map((pat) => new Glob(pat));
  const includeGlobs = config.include.map((pat) => new Glob(pat));

  function matchesAny(filePath: string, globs: Glob[]): boolean {
    return globs.some((g) => g.match(filePath));
  }

  const fsWatcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (!filename) return;

    const rel = filename.toString();

    if (matchesAny(rel, excludeGlobs)) return;
    if (!matchesAny(rel, includeGlobs)) return;

    const absPath = resolve(directory, rel);

    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);

    pending.set(
      absPath,
      setTimeout(async () => {
        pending.delete(absPath);

        if (!existsSync(absPath)) {
          const removed = db.removeFile(absPath);
          if (removed) {
            onEvent?.(`Removed deleted file: ${rel}`);
          }
          return;
        }

        const result = await indexFile(absPath, db, config);
        if (result === "indexed") {
          const file = db.getFileByPath(absPath);
          if (file) {
            // Build lookups once and reuse for all resolve calls
            const pathToId = buildPathToIdMap(db);
            const idToPath = buildIdToPathMap(pathToId);
            resolveImportsForFile(db, file.id, directory, pathToId, idToPath);
            for (const importerId of db.getImportersOf(file.id)) {
              resolveImportsForFile(db, importerId, directory, pathToId, idToPath);
            }
          }
          onEvent?.(`Re-indexed: ${rel}`);
        }
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
