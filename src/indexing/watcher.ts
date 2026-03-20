import { watch } from "fs";
import { resolve, relative } from "path";
import { existsSync } from "fs";
import { Glob } from "bun";
import { indexFile } from "./indexer";
import { type RagConfig } from "../config";
import { type RagDB } from "../db";
import { resolveImportsForFile } from "../graph/resolver";

const DEBOUNCE_MS = 2000;

function matchesAny(filePath: string, patterns: string[]): boolean {
  return patterns.some((pat) => new Glob(pat).match(filePath));
}

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

  const fsWatcher = watch(directory, { recursive: true }, (_event, filename) => {
    if (!filename) return;

    const rel = filename.toString();

    // Skip excluded paths
    if (matchesAny(rel, config.exclude)) return;

    // Only process files matching include patterns
    if (!matchesAny(rel, config.include)) return;

    const absPath = resolve(directory, rel);

    // Debounce: reset timer if same file changes again within window
    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);

    pending.set(
      absPath,
      setTimeout(async () => {
        pending.delete(absPath);

        if (!existsSync(absPath)) {
          // File was deleted
          const removed = db.removeFile(absPath);
          if (removed) {
            onEvent?.(`Removed deleted file: ${rel}`);
          }
          return;
        }

        const result = await indexFile(absPath, db, config);
        if (result === "indexed") {
          // Re-resolve imports for this file and its importers
          const file = db.getFileByPath(absPath);
          if (file) {
            resolveImportsForFile(db, file.id, directory);
            // Re-resolve files that import this one (exports may have changed)
            for (const importerId of db.getImportersOf(file.id)) {
              resolveImportsForFile(db, importerId, directory);
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
