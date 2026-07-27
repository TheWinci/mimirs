import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { chunk, SOURCE_RELATIONSHIP_EXTENSIONS } from "@winci/bun-chunk";

import {
  connectSourceFiles,
  parseGoModulePath,
  type AnalyzedSourceFile,
  type SourceRelationshipOptions,
  type SourceRelationshipResult,
} from "../source/relationships.ts";
import type { IndexConfig } from "../indexing/config.ts";
import { collectProjectFiles } from "./files.ts";

export { ProjectDirectoryNotFoundError } from "./files.ts";

export interface ProjectAnalysis {
  root: string;
  files: AnalyzedSourceFile[];
  relationships: SourceRelationshipResult;
}

export async function projectRelationshipOptions(
  root: string,
  projectPaths: ReadonlySet<string>,
): Promise<SourceRelationshipOptions> {
  try {
    return {
      goModulePath: parseGoModulePath(await readFile(join(root, "go.mod"), "utf8")),
      projectPaths,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projectPaths };
    throw error;
  }
}

/** Discover every regular project file, including non-source resources. */
export async function discoverProjectPaths(
  directory: string,
  config?: IndexConfig,
): Promise<string[]> {
  return (await collectProjectFiles(directory, config)).projectPaths;
}

async function isLikelyUtf8Text(root: string, path: string): Promise<boolean> {
  const sample = new Uint8Array(
    await Bun.file(join(root, path)).slice(0, 8192).arrayBuffer(),
  );
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  let controls = 0;
  for (const byte of sample) {
    if (byte < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(byte)) controls++;
  }
  return sample.length === 0 || controls / sample.length <= 0.01;
}

async function sourcePaths(root: string, candidatePaths: string[]): Promise<string[]> {
  const included = await Promise.all(candidatePaths.map(async (path) => {
    if (SOURCE_RELATIONSHIP_EXTENSIONS.has(extname(path).toLowerCase())) return path;
    return await isLikelyUtf8Text(root, path) ? path : null;
  }));
  return included.filter((path): path is string => path !== null);
}

/** Discover reviewed source files and conservative UTF-8 text fallbacks. */
export async function discoverProjectFiles(
  directory: string,
  config?: IndexConfig,
): Promise<string[]> {
  const files = await collectProjectFiles(directory, config);
  return sourcePaths(files.root, files.includedPaths);
}

/** Analyze supported project sources and connect their relationships. */
export async function analyzeProject(
  directory: string,
  config?: IndexConfig,
): Promise<ProjectAnalysis> {
  const discovered = await collectProjectFiles(directory, config);
  const { root, projectPaths } = discovered;
  const paths = await sourcePaths(root, discovered.includedPaths);
  const files: AnalyzedSourceFile[] = [];
  for (const path of paths) {
    files.push({
      path,
      result: await chunk(path, await Bun.file(join(root, path)).text()),
    });
  }
  return {
    root,
    files,
    relationships: connectSourceFiles(
      files,
      await projectRelationshipOptions(root, new Set(projectPaths)),
    ),
  };
}
