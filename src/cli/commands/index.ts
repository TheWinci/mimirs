import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  loadInitializedIndexConfig,
  type IndexConfig,
} from "../../internals/indexing/config.ts";
import {
  isProcessAlive,
  readProjectIndexLock,
  tryAcquireProjectIndexLock,
  type ProjectIndexLock,
  type ProjectIndexLockOwner,
} from "../../internals/indexing/lock.ts";
import {
  initialProjectIndexStatus,
  projectIndexDomainStatuses,
  readSharedProjectStatus,
  writeSharedProjectStatus,
  type ProjectIndexStatus,
  type SharedProjectStatus,
} from "../../internals/indexing/status.ts";
import {
  observeProject,
  RefreshCoordinator,
  type ProjectWatchObserverFactory,
} from "../../internals/indexing/watch.ts";
import { ProjectDirectoryNotFoundError } from
  "../../internals/project/analysis.ts";
import { projectLayout } from "../../internals/project/layout.ts";
import {
  ProjectSearchSession,
  type ProjectSearchPreparation,
  type ProjectSearchSessionOptions,
} from "../../internals/search/project-search.ts";
import { SOURCE_INDEX_SCHEMA_VERSION } from
  "../../internals/storage/schema.ts";
import {
  IndexProgressRenderer,
  type IndexProgressStream,
} from
  "../renderers/index-progress.ts";

export const INDEX_USAGE =
  "Usage: mimirs index [-d <directory>] [--watch]\n" +
  "       mimirs index status [-d <directory>]";

export interface ParsedIndexArguments {
  command: "index" | "status";
  directory: string;
  watch: boolean;
}

export interface IndexCommandOutput {
  error(message: string): void;
  log(message: string): void;
  /** Optional progress destination; the real CLI defaults to stderr. */
  progressStream?: IndexProgressStream;
}

export interface ProjectIndexRefreshResult {
  root: string;
  status: SharedProjectStatus;
  durationMs: number;
}

export interface IndexCommandDependencies {
  index(
    directory: string,
    output: IndexCommandOutput,
  ): Promise<ProjectIndexRefreshResult>;
  watch(
    directory: string,
    output: IndexCommandOutput,
  ): Promise<ProjectIndexRefreshResult>;
  readStatus(directory: string): Promise<SharedProjectStatus | null>;
  readLock(directory: string): Promise<ProjectIndexLockOwner | null>;
  assertDirectory(directory: string): Promise<void>;
}

class IndexArgumentError extends Error {}

export class ProjectIndexWriterBusyError extends Error {
  constructor(directory: string) {
    super(
      `another index command owns ${projectLayout(directory).root}; ` +
        "retry after it finishes",
    );
    this.name = "ProjectIndexWriterBusyError";
  }
}

function value(args: string[], index: number, flag: string): string {
  const found = args[index + 1];
  if (
    found === undefined || found.startsWith("-") || found.trim().length === 0
  ) {
    throw new IndexArgumentError(`${flag} requires a non-empty path`);
  }
  return found;
}

export function parseIndexArguments(args: string[]): ParsedIndexArguments {
  const status = args[0] === "status";
  const options = status ? args.slice(1) : args;
  let directory: string | undefined;
  let watch = false;

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
    if (option === "--watch") {
      if (status) {
        throw new IndexArgumentError("--watch is not valid with index status");
      }
      if (watch) {
        throw new IndexArgumentError("--watch may only be provided once");
      }
      watch = true;
      continue;
    }
    throw new IndexArgumentError(`unknown index option: ${option}`);
  }

  return {
    command: status ? "status" : "index",
    directory: directory ?? ".",
    watch,
  };
}

async function assertDirectory(directory: string): Promise<void> {
  const root = projectLayout(directory).root;
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
  preparation: ProjectSearchPreparation,
): ProjectIndexStatus {
  const partial = preparation.index.failed.length > 0;
  return {
    state: partial ? "degraded" : "ready",
    searchable: true,
    ownerPid: process.pid,
    generation: (previous?.index.generation ?? 0) + 1,
    phase: null,
    progress: null,
    files: preparation.index.discovered,
    sourceChunks: null,
    embeddedWindows: preparation.embeddings.total,
    lastUpdatedAt: new Date().toISOString(),
    error: partial
      ? {
          code: "PARTIAL_INDEX",
          message: `${preparation.index.failed.length} files could not be indexed`,
          retryable: true,
        }
      : null,
  };
}

function sharedStatus(
  root: string,
  owner: ProjectIndexLockOwner,
  index: ProjectIndexStatus,
  config: IndexConfig | null,
  preparation: ProjectSearchPreparation | null,
): SharedProjectStatus {
  return {
    version: 2,
    sourceIndexSchemaVersion: SOURCE_INDEX_SCHEMA_VERSION,
    root,
    owner,
    index,
    domains: projectIndexDomainStatuses(root, config, index),
    preparation,
    config,
  };
}

class ProjectIndexer {
  private previous: SharedProjectStatus | null;
  private closed = false;

  private constructor(
    readonly root: string,
    private readonly lock: ProjectIndexLock,
    private readonly session: ProjectSearchSession,
    previous: SharedProjectStatus | null,
  ) {
    this.previous = previous;
  }

  static async open(
    directory: string,
    sessionOptions: Omit<ProjectSearchSessionOptions, "config" | "signal"> = {},
  ): Promise<ProjectIndexer> {
    const root = projectLayout(directory).root;
    await assertDirectory(root);
    const config = await loadInitializedIndexConfig(root);
    const lock = await tryAcquireProjectIndexLock(
      root,
      `cli-${randomUUID().replaceAll("-", "")}`,
    );
    if (!lock) throw new ProjectIndexWriterBusyError(root);
    try {
      const [session, previous] = await Promise.all([
        ProjectSearchSession.open(root, { ...sessionOptions, config }),
        readSharedProjectStatus(root),
      ]);
      return new ProjectIndexer(root, lock, session, previous);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async refresh(): Promise<ProjectIndexRefreshResult> {
    if (this.closed) throw new Error("project indexer is closed");
    const startedAt = performance.now();
    let config: IndexConfig | null = null;
    try {
      config = await loadInitializedIndexConfig(this.root);
      const preparation = await this.session.refresh(config);
      const index = completedStatus(this.previous, preparation);
      index.files = this.session.sourceIndex.listFiles().length;
      index.sourceChunks = this.session.sourceIndex.countChunks();
      index.embeddedWindows = this.session.sourceIndex.countSemanticVectors();
      const status = sharedStatus(
        this.root,
        this.lock.owner,
        index,
        config,
        preparation,
      );
      await writeSharedProjectStatus(this.root, status);
      this.previous = status;
      return {
        root: this.root,
        status,
        durationMs: performance.now() - startedAt,
      };
    } catch (error) {
      const prior = this.previous?.index ?? initialProjectIndexStatus();
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
      const status = sharedStatus(
        this.root,
        this.lock.owner,
        index,
        config ?? this.previous?.config ?? null,
        null,
      );
      await writeSharedProjectStatus(this.root, status).catch(() => undefined);
      this.previous = status;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.close().catch(() => undefined);
    await this.lock.release();
  }
}

export async function indexProjectOnce(
  directory: string,
  sessionOptions: Omit<ProjectSearchSessionOptions, "config" | "signal"> = {},
): Promise<ProjectIndexRefreshResult> {
  const indexer = await ProjectIndexer.open(directory, sessionOptions);
  try {
    return await indexer.refresh();
  } finally {
    await indexer.close();
  }
}

function progressRenderer(
  output: IndexCommandOutput,
): IndexProgressRenderer | null {
  const stream = output.progressStream ??
    (output === console ? process.stderr : null);
  return stream ? new IndexProgressRenderer(stream) : null;
}

function withProgress(
  options: Omit<ProjectSearchSessionOptions, "config" | "signal">,
  renderer: IndexProgressRenderer | null,
): Omit<ProjectSearchSessionOptions, "config" | "signal"> {
  if (!renderer) return options;
  return {
    ...options,
    onIndexProgress: async (progress) => {
      renderer.indexing(progress);
      await options.onIndexProgress?.(progress);
    },
    onEmbeddingProgress: async (progress) => {
      renderer.embedding(progress);
      await options.onEmbeddingProgress?.(progress);
    },
  };
}

export async function indexProjectWithProgress(
  directory: string,
  output: IndexCommandOutput,
  sessionOptions: Omit<ProjectSearchSessionOptions, "config" | "signal"> = {},
): Promise<ProjectIndexRefreshResult> {
  const renderer = progressRenderer(output);
  const indexer = await ProjectIndexer.open(
    directory,
    withProgress(sessionOptions, renderer),
  );
  try {
    renderer?.start();
    return await indexer.refresh();
  } finally {
    renderer?.finish();
    await indexer.close();
  }
}

export interface WatchSourceIndexOptions {
  debounceMs?: number;
  maximumDelayMs?: number;
  observer?: ProjectWatchObserverFactory;
  session?: Omit<ProjectSearchSessionOptions, "config" | "signal">;
  signal?: AbortSignal;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function renderIndexSummary(
  result: ProjectIndexRefreshResult,
): string {
  const status = result.status.index;
  const preparation = result.status.preparation;
  const lines = [
    `Indexed ${result.root}`,
    `  Generation: ${status.generation} (${status.state})`,
  ];
  if (preparation) {
    lines.push(
      `  Files: ${preparation.index.discovered} total; ` +
        `${preparation.index.indexed} indexed, ` +
        `${preparation.index.unchanged} unchanged, ` +
        `${preparation.index.failed.length} failed`,
      `  Chunks: ${status.sourceChunks ?? 0}`,
      `  Embeddings: ${preparation.embeddings.total} total; ` +
        `${preparation.embeddings.embedded} embedded, ` +
        `${preparation.embeddings.unchanged} unchanged, ` +
        `${preparation.embeddings.batches} ` +
        (preparation.embeddings.batches === 1 ? "batch" : "batches"),
    );
  } else {
    lines.push(
      `  Files: ${status.files ?? 0}`,
      `  Chunks: ${status.sourceChunks ?? 0}`,
      `  Embeddings: ${status.embeddedWindows ?? 0}`,
    );
  }
  lines.push(`  Duration: ${formatDuration(result.durationMs)}`);
  return lines.join("\n");
}

export async function watchSourceIndex(
  directory: string,
  output: IndexCommandOutput = console,
  options: WatchSourceIndexOptions = {},
): Promise<ProjectIndexRefreshResult> {
  const renderer = progressRenderer(output);
  const indexer = await ProjectIndexer.open(
    directory,
    withProgress(options.session ?? {}, renderer),
  );
  const abort = new AbortController();
  let last: ProjectIndexRefreshResult | null = null;
  let observer: ReturnType<ProjectWatchObserverFactory> | null = null;
  let rejectObserver: ((error: Error) => void) | null = null;
  const observerFailure = new Promise<never>((_resolve, reject) => {
    rejectObserver = reject;
  });
  const coordinator = new RefreshCoordinator(async () => {
    renderer?.start();
    try {
      last = await indexer.refresh();
    } finally {
      renderer?.finish();
    }
    output.log(renderIndexSummary(last));
  }, {
    debounceMs: options.debounceMs,
    maximumDelayMs: options.maximumDelayMs,
    onError: (error) => output.error(`[mimirs] watch refresh failed: ${error.message}`),
  });
  const stop = (): void => abort.abort();
  const relayAbort = (): void => abort.abort(options.signal?.reason);

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  options.signal?.addEventListener("abort", relayAbort, { once: true });

  try {
    observer = (options.observer ?? observeProject)(
      indexer.root,
      () => coordinator.notify(),
      (error) => rejectObserver?.(error),
    );
    await coordinator.refreshNow();
    if (!last) {
      throw new Error("initial watch refresh did not complete");
    }
    output.log(`Watching ${indexer.root}`);
    if (options.signal?.aborted) relayAbort();
    await Promise.race([
      new Promise<void>((resolve) =>
        abort.signal.addEventListener("abort", () => resolve(), { once: true })
      ),
      observerFailure,
    ]);
    return last;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    options.signal?.removeEventListener("abort", relayAbort);
    observer?.close();
    await coordinator.close();
    await indexer.close();
  }
}

const DEFAULT_DEPENDENCIES: IndexCommandDependencies = {
  index: indexProjectWithProgress,
  watch: watchSourceIndex,
  readStatus: readSharedProjectStatus,
  readLock: readProjectIndexLock,
  assertDirectory,
};

function renderStatus(
  status: SharedProjectStatus | null,
  lock: ProjectIndexLockOwner | null,
): string {
  if (!status) {
    if (!lock) return "No persisted index status.\nWriter: inactive";
    return "No persisted index status.\n" +
      (isProcessAlive(lock.pid)
        ? `Writer: active (pid ${lock.pid})`
        : `Writer: stale (pid ${lock.pid})`);
  }
  const lines = [
    `Index: ${status.index.state}`,
    `Generation: ${status.index.generation}`,
  ];
  if (lock) {
    lines.push(
      isProcessAlive(lock.pid)
        ? `Writer: active (pid ${lock.pid})`
        : `Writer: stale (pid ${lock.pid})`,
    );
  } else {
    lines.push("Writer: inactive");
  }
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
      const [status, lock] = await Promise.all([
        dependencies.readStatus(parsed.directory),
        dependencies.readLock(parsed.directory),
      ]);
      output.log(renderStatus(status, lock));
      return 0;
    }
    const result = parsed.watch
      ? await dependencies.watch(parsed.directory, output)
      : await dependencies.index(parsed.directory, output);
    if (!parsed.watch) output.log(renderIndexSummary(result));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    return error instanceof ProjectDirectoryNotFoundError ? 2 : 1;
  }
}
