import { resolve } from "node:path";

import { loadInitializedIndexConfig } from "../indexing/config.ts";
import { projectLayout } from "../project/layout.ts";
import {
  ProjectSearchSession,
  type ProjectSearchResponse,
  type ProjectSearchSessionOptions,
} from "./project-search.ts";
import type { SearchRequest } from "./search.ts";
import { SourceIndexSchemaMismatchError } from
  "../storage/source-index.ts";

export class ProjectNotIndexedError extends Error {
  constructor(directory: string) {
    super(
      `project is not indexed: ${resolve(directory)}; ` +
        "run `mimirs index -d <directory>` first",
    );
    this.name = "ProjectNotIndexedError";
  }
}

export class ProjectIndexSchemaCompatibilityError extends Error {
  constructor(
    directory: string,
    mismatch: SourceIndexSchemaMismatchError,
  ) {
    const root = resolve(directory);
    super(
      mismatch.actual < mismatch.expected
        ? `project index schema ${mismatch.actual} requires migration to ` +
          `${mismatch.expected}; run \`mimirs index -d .\` ` +
          `from ${root}`
        : `project index schema ${mismatch.actual} was created by a newer ` +
          `Mimirs version; upgrade Mimirs before searching ${root}`,
    );
    this.name = "ProjectIndexSchemaCompatibilityError";
  }
}

export async function openReadOnlyProjectSearch(
  directory: string,
  options: Omit<ProjectSearchSessionOptions, "databasePath" | "readOnly"> = {},
): Promise<ProjectSearchSession> {
  const layout = projectLayout(directory);
  const config = await loadInitializedIndexConfig(layout.root);
  if (!(await Bun.file(layout.databasePath).exists())) {
    throw new ProjectNotIndexedError(directory);
  }

  let session: ProjectSearchSession;
  try {
    session = await ProjectSearchSession.open(directory, {
      ...options,
      config,
      readOnly: true,
    });
  } catch (error) {
    if (error instanceof SourceIndexSchemaMismatchError) {
      throw new ProjectIndexSchemaCompatibilityError(
        directory,
        error,
      );
    }
    throw error;
  }

  try {
    await session.attachOwnedIndex();
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function searchReadOnlyProject(
  directory: string,
  request: SearchRequest,
  options: Omit<ProjectSearchSessionOptions, "databasePath" | "readOnly"> = {},
): Promise<ProjectSearchResponse> {
  const session = await openReadOnlyProjectSearch(
    directory,
    options,
  );
  try {
    return await session.search(request);
  } finally {
    await session.close();
  }
}
