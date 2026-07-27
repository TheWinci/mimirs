import { join, resolve } from "node:path";

import {
  discoverProjectFiles,
  discoverProjectPaths,
  projectRelationshipOptions,
  type ProjectAnalysis,
} from "../project/analysis.ts";
import { connectSourceFiles } from "../source/relationships.ts";
import type { SourceWindowOptions } from "../source/windows.ts";
import type { IndexConfig } from "../indexing/config.ts";
import type { SourceIndex } from "./source-index.ts";

export interface ProjectIndexFailure {
  path: string;
  message: string;
}

export interface ProjectIndexSummary {
  root: string;
  discovered: number;
  indexed: number;
  unchanged: number;
  /** Paths whose current source was successfully indexed or confirmed unchanged. */
  currentPaths: string[];
  failed: ProjectIndexFailure[];
}

export interface ProjectIndexOptions extends SourceWindowOptions {
  config?: IndexConfig;
  onProgress?: (progress: ProjectIndexProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ProjectIndexProgress {
  completed: number;
  total: number;
  path: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Index every discovered source into a caller-owned, project-specific index.
 * Paths are stored relative to the project root. Once every discovered path
 * has been attempted, the persisted database is reconciled to the files that
 * were successfully indexed or confirmed unchanged. An interrupted scan does
 * not reconcile, so paths not yet processed remain available.
 */
export async function indexProject(
  directory: string,
  index: SourceIndex,
  options: ProjectIndexOptions = {},
): Promise<ProjectIndexSummary> {
  options.signal?.throwIfAborted();
  const root = resolve(directory);
  const paths = await discoverProjectFiles(root, options.config);
  options.signal?.throwIfAborted();
  const summary: ProjectIndexSummary = {
    root,
    discovered: paths.length,
    indexed: 0,
    unchanged: 0,
    currentPaths: [],
    failed: [],
  };

  await options.onProgress?.({ completed: 0, total: paths.length, path: null });

  const currentPaths = new Set<string>();

  for (let ordinal = 0; ordinal < paths.length; ordinal++) {
    options.signal?.throwIfAborted();
    const path = paths[ordinal]!;
    try {
      const result = await index.indexFile(
        path,
        await Bun.file(join(root, path)).text(),
        { targetCharacters: options.targetCharacters },
      );
      if (result.changed) summary.indexed++;
      else summary.unchanged++;
      summary.currentPaths.push(path);
      currentPaths.add(path);
    } catch (error) {
      options.signal?.throwIfAborted();
      summary.failed.push({ path, message: errorMessage(error) });
    }
    await options.onProgress?.({
      completed: ordinal + 1,
      total: paths.length,
      path,
    });
    options.signal?.throwIfAborted();
  }

  options.signal?.throwIfAborted();
  index.reconcileFiles(currentPaths);

  return summary;
}

/** Derive current project relationships entirely from persisted analysis. */
export async function analyzeIndexedProject(
  directory: string,
  index: SourceIndex,
  config?: IndexConfig,
): Promise<ProjectAnalysis> {
  const root = resolve(directory);
  const projectPaths = await discoverProjectPaths(root, config);
  const files = index.loadAnalyzedFiles();
  return {
    root,
    files,
    relationships: connectSourceFiles(
      files,
      await projectRelationshipOptions(root, new Set(projectPaths)),
    ),
  };
}
