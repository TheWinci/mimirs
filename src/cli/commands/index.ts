import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  setIndexDomainEnabled,
} from "../../internals/indexing/config.ts";
import { tryAcquireProjectIndexLock } from
  "../../internals/indexing/lock.ts";
import { ProjectDirectoryNotFoundError } from
  "../../internals/project/analysis.ts";
import { projectLayout } from "../../internals/project/layout.ts";
import {
  ProjectSearchSession,
  type ProjectSearchPreparation,
  type ProjectSearchSessionOptions,
} from "../../internals/search/project-search.ts";
import {
  initialProjectIndexStatus,
  projectIndexDomainStatuses,
  readSharedProjectStatus,
  writeSharedProjectStatus,
  type ProjectIndexStatus,
  type SharedProjectStatus,
} from "../../internals/indexing/status.ts";
import { SOURCE_INDEX_SCHEMA_VERSION } from
  "../../internals/storage/schema.ts";

export const INDEX_USAGE =
  "Usage: mimirs index <source|history|conversations> " +
  "<enable|disable> -d <directory> [--state-dir <directory>]\n" +
  "       mimirs index status -d <directory> [--state-dir <directory>]";

type IndexDomain = "source" | "history" | "conversations";
type IndexAction = "enable" | "disable";

interface ParsedIndexArguments {
  command: "status" | "configure";
  domain?: IndexDomain;
  action?: IndexAction;
  directory: string;
  stateDirectory?: string;
}

export interface IndexCommandOutput {
  error(message: string): void;
  log(message: string): void;
}

export interface IndexCommandDependencies {
  configureSource(
    directory: string,
    enabled: boolean,
    stateDirectory?: string,
  ): Promise<"completed">;
  readStatus(
    directory: string,
    stateDirectory?: string,
  ): Promise<SharedProjectStatus | null>;
  assertDirectory(directory: string): Promise<void>;
}

class IndexArgumentError extends Error {}
export class ProjectIndexWriterBusyError extends Error {
  constructor(directory: string) {
    super(
      `another index command owns ${resolve(directory)}; retry after it finishes`,
    );
    this.name = "ProjectIndexWriterBusyError";
  }
}

function value(args: string[], index: number, flag: string): string {
  const found = args[index + 1];
  if (found === undefined || found.startsWith("-")) {
    throw new IndexArgumentError(`${flag} requires a value`);
  }
  return found;
}

export function parseIndexArguments(args: string[]): ParsedIndexArguments {
  const [first, second, ...rest] = args;
  const domains: IndexDomain[] = ["source", "history", "conversations"];
  let command: ParsedIndexArguments["command"];
  let domain: IndexDomain | undefined;
  let action: IndexAction | undefined;
  if (first === "status") {
    command = "status";
    if (
      second !== undefined && second !== "-d" && second !== "--directory" &&
      second !== "--state-dir"
    ) {
      throw new IndexArgumentError("index status does not accept an action");
    }
  } else {
    if (!domains.includes(first as IndexDomain)) {
      throw new IndexArgumentError("index domain must be source, history, or conversations");
    }
    domain = first as IndexDomain;
    if (second !== "enable" && second !== "disable") {
      throw new IndexArgumentError("index action must be enable or disable");
    }
    action = second;
    command = "configure";
  }

  const options = first === "status" ? args.slice(1) : rest;
  let directory: string | undefined;
  let stateDirectory: string | undefined;
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!;
    if (option === "-d" || option === "--directory") {
      if (directory !== undefined) {
        throw new IndexArgumentError("directory may only be provided once");
      }
      directory = value(options, index, option);
      index++;
      continue;
    }
    if (option === "--state-dir") {
      if (stateDirectory !== undefined) {
        throw new IndexArgumentError("state directory may only be provided once");
      }
      stateDirectory = value(options, index, option);
      if (stateDirectory.trim() === "") {
        throw new IndexArgumentError("--state-dir must not be empty");
      }
      index++;
      continue;
    }
    throw new IndexArgumentError(`unknown index option: ${option}`);
  }
  if (directory === undefined) {
    throw new IndexArgumentError("-d <directory> is required");
  }
  return {
    command,
    domain,
    action,
    directory,
    ...(stateDirectory === undefined ? {} : { stateDirectory }),
  };
}

async function assertDirectory(directory: string): Promise<void> {
  const root = resolve(directory);
  try {
    if (!(await stat(root)).isDirectory()) {
      throw new ProjectDirectoryNotFoundError(directory);
    }
  } catch (error) {
    if (error instanceof ProjectDirectoryNotFoundError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectDirectoryNotFoundError(directory);
    }
    throw error;
  }
}

function completedStatus(
  previous: SharedProjectStatus | null,
  preparation: ProjectSearchPreparation | null,
  searchable: boolean,
): ProjectIndexStatus {
  const files = preparation?.index.discovered ?? 0;
  const partial = (preparation?.index.failed.length ?? 0) > 0;
  return {
    state: partial ? "degraded" : "ready",
    searchable,
    ownerPid: process.pid,
    generation: (previous?.index.generation ?? 0) + 1,
    phase: null,
    progress: null,
    files,
    sourceChunks: searchable ? null : 0,
    embeddedWindows: preparation?.embeddings.total ?? 0,
    lastUpdatedAt: new Date().toISOString(),
    error: partial
      ? {
          code: "PARTIAL_INDEX",
          message: `${preparation!.index.failed.length} files could not be indexed`,
          retryable: true,
        }
      : null,
  };
}

export async function configureSourceIndex(
  directory: string,
  enabled: boolean,
  sessionOptions: ProjectSearchSessionOptions = {},
  stateDirectory?: string,
): Promise<"completed"> {
  const layout = projectLayout(directory, stateDirectory);
  const root = layout.root;
  const stateHost = layout.stateHost;
  await assertDirectory(root);
  const lock = await tryAcquireProjectIndexLock(
    root,
    `cli-${randomUUID().replaceAll("-", "")}`,
    process.pid,
    stateHost,
  );
  if (!lock) throw new ProjectIndexWriterBusyError(root);

  const config = await setIndexDomainEnabled(
    root,
    "source",
    enabled,
    stateHost,
  );
  const previous = await readSharedProjectStatus(root, stateHost);
  let session: ProjectSearchSession | null = null;
  try {
    const databasePath = layout.databasePath;
    if (enabled || await Bun.file(databasePath).exists()) {
      session = await ProjectSearchSession.open(root, {
        ...sessionOptions,
        config,
        stateDirectory: stateHost,
      });
      const preparation = await session.refresh();
      const index = completedStatus(previous, preparation, true);
      index.files = session.sourceIndex.listFiles().length;
      index.sourceChunks = session.sourceIndex.countChunks();
      index.embeddedWindows = session.sourceIndex.countSemanticVectors();
      await writeSharedProjectStatus(root, {
        version: 2,
        sourceIndexSchemaVersion: SOURCE_INDEX_SCHEMA_VERSION,
        root,
        owner: lock.owner,
        index,
        domains: projectIndexDomainStatuses(root, config, index),
        preparation,
        config,
      }, stateHost);
    } else {
      const index = completedStatus(previous, null, false);
      await writeSharedProjectStatus(root, {
        version: 2,
        sourceIndexSchemaVersion: SOURCE_INDEX_SCHEMA_VERSION,
        root,
        owner: lock.owner,
        index,
        domains: projectIndexDomainStatuses(root, config, index),
        preparation: null,
        config,
      }, stateHost);
    }
    return "completed";
  } catch (error) {
    const prior = previous?.index ?? initialProjectIndexStatus();
    const index: ProjectIndexStatus = {
      ...prior,
      state: prior.searchable ? "degraded" : "failed",
      ownerPid: process.pid,
      phase: null,
      progress: null,
      error: {
        code: "CLI_INDEX_FAILED",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
    await writeSharedProjectStatus(root, {
      version: 2,
      sourceIndexSchemaVersion: SOURCE_INDEX_SCHEMA_VERSION,
      root,
      owner: lock.owner,
      index,
      domains: projectIndexDomainStatuses(root, config, index),
      preparation: null,
      config,
    }, stateHost).catch(() => undefined);
    throw error;
  } finally {
    await session?.close().catch(() => undefined);
    await lock.release();
  }
}

const DEFAULT_DEPENDENCIES: IndexCommandDependencies = {
  configureSource: (directory, enabled, stateDirectory) =>
    configureSourceIndex(directory, enabled, {}, stateDirectory),
  readStatus: readSharedProjectStatus,
  assertDirectory,
};

function renderStatus(status: SharedProjectStatus | null): string {
  if (!status) return "No persisted index status.";
  const lines = [
    `Index: ${status.index.state}`,
    `Generation: ${status.index.generation}`,
  ];
  for (const name of ["source", "history", "conversations"] as const) {
    const domain = status.domains[name];
    lines.push(`${name}: ${domain.state}`);
    if (domain.error) lines.push(`  error: ${domain.error.message}`);
  }
  if (status.index.error) lines.push(`Error: ${status.index.error.message}`);
  return lines.join("\n");
}

export async function runIndex(
  args: string[],
  dependencies: IndexCommandDependencies = DEFAULT_DEPENDENCIES,
  output: IndexCommandOutput = console,
): Promise<number> {
  let parsed: ParsedIndexArguments;
  try {
    parsed = parseIndexArguments(args);
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    output.error(INDEX_USAGE);
    return 2;
  }

  try {
    await dependencies.assertDirectory(parsed.directory);
    if (parsed.command === "status") {
      output.log(renderStatus(await dependencies.readStatus(
        parsed.directory,
        parsed.stateDirectory,
      )));
      return 0;
    }
    if (parsed.domain !== "source") {
      output.error(`${parsed.domain} indexing is not implemented yet`);
      return 1;
    }
    await dependencies.configureSource(
      parsed.directory,
      parsed.action === "enable",
      parsed.stateDirectory,
    );
    output.log(`source indexing ${parsed.action}d for ${resolve(parsed.directory)}`);
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return error instanceof ProjectDirectoryNotFoundError ? 2 : 1;
  }
}
