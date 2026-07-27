import { resolve } from "node:path";

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
  constructor(directory: string, stateDirectory?: string) {
    const stateOption = stateDirectory
      ? ` --state-dir ${JSON.stringify(resolve(stateDirectory))}`
      : "";
    super(
      `project is not indexed: ${resolve(directory)}; ` +
        `run \`mimirs index source enable -d <directory>${stateOption}\` first`,
    );
    this.name = "ProjectNotIndexedError";
  }
}

export class ProjectIndexSchemaCompatibilityError extends Error {
  constructor(
    directory: string,
    mismatch: SourceIndexSchemaMismatchError,
    stateDirectory?: string,
  ) {
    const root = resolve(directory);
    const stateOption = stateDirectory
      ? ` --state-dir ${JSON.stringify(resolve(stateDirectory))}`
      : "";
    super(
      mismatch.actual < mismatch.expected
        ? `project index schema ${mismatch.actual} requires migration to ` +
          `${mismatch.expected}; run \`mimirs index source enable -d .${stateOption}\` ` +
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
  stateDirectory?: string,
): Promise<ProjectSearchSession> {
  const layout = projectLayout(directory, stateDirectory);
  if (!(await Bun.file(layout.databasePath).exists())) {
    throw new ProjectNotIndexedError(directory, stateDirectory);
  }

  let session: ProjectSearchSession;
  try {
    session = await ProjectSearchSession.open(directory, {
      ...options,
      stateDirectory: layout.stateHost,
      readOnly: true,
    });
  } catch (error) {
    if (error instanceof SourceIndexSchemaMismatchError) {
      throw new ProjectIndexSchemaCompatibilityError(
        directory,
        error,
        stateDirectory,
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
  stateDirectory?: string,
): Promise<ProjectSearchResponse> {
  const session = await openReadOnlyProjectSearch(
    directory,
    options,
    stateDirectory,
  );
  try {
    return await session.search(request);
  } finally {
    await session.close();
  }
}
