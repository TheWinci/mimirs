import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ProjectSearchPreparation } from "../search/project-search.ts";
import type { ProjectIndexLockOwner } from "./lock.ts";
import {
  indexDomains,
  type IndexConfig,
} from "./config.ts";
import {
  ensureProjectState,
  projectLayout,
} from "../project/layout.ts";

export type ProjectIndexState =
  | "preparing"
  | "indexing"
  | "ready"
  | "updating"
  | "degraded"
  | "failed";
export type ProjectIndexPhase =
  | "ownership"
  | "database"
  | "scanning"
  | "indexing"
  | "embedding"
  | "fact-embedding"
  | "relation-embedding"
  | null;

export interface ProjectStatusError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProjectIndexProgress {
  completed: number;
  total: number;
}

export interface ProjectIndexStatus {
  state: ProjectIndexState;
  searchable: boolean;
  ownerPid: number | null;
  generation: number;
  phase: ProjectIndexPhase;
  progress: ProjectIndexProgress | null;
  files: number | null;
  sourceChunks: number | null;
  embeddedWindows: number | null;
  factDocuments: number | null;
  embeddedFacts: number | null;
  relationDocuments: number | null;
  embeddedRelations: number | null;
  lastUpdatedAt: string | null;
  error: ProjectStatusError | null;
}

export type ProjectIndexDomainState = ProjectIndexState | "disabled" |
  "not-implemented";

export interface ProjectIndexDomainStatus {
  state: ProjectIndexDomainState;
  directories: string[];
  generation: number;
  phase: ProjectIndexPhase;
  progress: ProjectIndexProgress | null;
  lastUpdatedAt: string | null;
  error: ProjectStatusError | null;
}

export interface ProjectIndexDomainStatuses {
  source: ProjectIndexDomainStatus;
  history: ProjectIndexDomainStatus;
  conversations: ProjectIndexDomainStatus;
}

export interface SharedProjectStatus {
  version: 2;
  sourceIndexSchemaVersion: number;
  root: string;
  owner: ProjectIndexLockOwner;
  index: ProjectIndexStatus;
  domains: ProjectIndexDomainStatuses;
  preparation: ProjectSearchPreparation | null;
  config: IndexConfig | null;
}

function finiteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return finiteNonNegativeInteger(value) && value > 0;
}

function isPreparation(value: unknown): value is ProjectSearchPreparation {
  if (!value || typeof value !== "object") return false;
  const preparation = value as Partial<ProjectSearchPreparation>;
  const index = preparation.index;
  const embeddings = preparation.embeddings;
  const facts = preparation.facts;
  const relations = preparation.relations;
  const isPerspectiveSummary = (summary: typeof facts): boolean =>
    !!summary && typeof summary.model === "string" &&
    typeof summary.revision === "string" &&
    typeof summary.variant === "string" &&
    positiveInteger(summary.dimensions) &&
    finiteNonNegativeInteger(summary.total) &&
    finiteNonNegativeInteger(summary.embedded) &&
    finiteNonNegativeInteger(summary.unchanged) &&
    finiteNonNegativeInteger(summary.batches) &&
    finiteNonNegativeInteger(summary.projectedFiles) &&
    finiteNonNegativeInteger(summary.changedProjectionFiles);
  return !!index && typeof index.root === "string" &&
    finiteNonNegativeInteger(index.discovered) &&
    finiteNonNegativeInteger(index.indexed) &&
    finiteNonNegativeInteger(index.unchanged) && Array.isArray(index.failed) &&
    index.failed.every((failure) =>
      !!failure && typeof failure.path === "string" &&
      typeof failure.message === "string"
    ) && !!embeddings && typeof embeddings.model === "string" &&
    typeof embeddings.revision === "string" &&
    typeof embeddings.variant === "string" &&
    positiveInteger(embeddings.dimensions) &&
    finiteNonNegativeInteger(embeddings.total) &&
    finiteNonNegativeInteger(embeddings.embedded) &&
    finiteNonNegativeInteger(embeddings.unchanged) &&
    finiteNonNegativeInteger(embeddings.batches) &&
    isPerspectiveSummary(facts) && isPerspectiveSummary(relations);
}

function isConfig(value: unknown): value is IndexConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<IndexConfig>;
  return Array.isArray(config.include) &&
    config.include.every((pattern) => typeof pattern === "string") &&
    Array.isArray(config.exclude) &&
    config.exclude.every((pattern) => typeof pattern === "string") &&
    (config.generated === undefined || (
      Array.isArray(config.generated) &&
      config.generated.every((pattern) => typeof pattern === "string")
    )) && (config.index === undefined || isDomainConfig(config.index));
}

function isDomainConfig(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const domains = value as Record<string, unknown>;
  const directories = (domain: unknown): boolean => {
    if (!domain || typeof domain !== "object") return false;
    const values = (domain as { directories?: unknown }).directories;
    return Array.isArray(values) &&
      values.every((directory) => typeof directory === "string");
  };
  return directories(domains.source) && directories(domains.history) &&
    directories(domains.conversations) &&
    (domains.history as { provider?: unknown }).provider === "git";
}

function isDomainStatus(value: unknown): value is ProjectIndexDomainStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<ProjectIndexDomainStatus>;
  const states: ProjectIndexDomainState[] = [
    "preparing",
    "indexing",
    "ready",
    "updating",
    "degraded",
    "failed",
    "disabled",
    "not-implemented",
  ];
  return states.includes(status.state as ProjectIndexDomainState) &&
    Array.isArray(status.directories) &&
    status.directories.every((directory) => typeof directory === "string") &&
    finiteNonNegativeInteger(status.generation) &&
    ([
      "ownership",
      "database",
      "scanning",
      "indexing",
      "embedding",
      "fact-embedding",
      "relation-embedding",
      null,
    ]
      .includes(status.phase as ProjectIndexPhase)) &&
    (status.progress === null || (
      !!status.progress && finiteNonNegativeInteger(status.progress.completed) &&
      finiteNonNegativeInteger(status.progress.total) &&
      status.progress.completed <= status.progress.total
    )) &&
    (status.lastUpdatedAt === null || typeof status.lastUpdatedAt === "string") &&
    (status.error === null || (
      !!status.error && typeof status.error.code === "string" &&
      typeof status.error.message === "string" &&
      typeof status.error.retryable === "boolean"
    ));
}

function isDomainStatuses(value: unknown): value is ProjectIndexDomainStatuses {
  if (!value || typeof value !== "object") return false;
  const statuses = value as Partial<ProjectIndexDomainStatuses>;
  return isDomainStatus(statuses.source) && isDomainStatus(statuses.history) &&
    isDomainStatus(statuses.conversations);
}

function isIndexStatus(value: unknown): value is ProjectIndexStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<ProjectIndexStatus>;
  const states: ProjectIndexState[] = [
    "preparing",
    "indexing",
    "ready",
    "updating",
    "degraded",
    "failed",
  ];
  const phases: ProjectIndexPhase[] = [
    "ownership",
    "database",
    "scanning",
    "indexing",
    "embedding",
    "fact-embedding",
    "relation-embedding",
    null,
  ];
  const nullableCount = (count: unknown): boolean =>
    count === null || finiteNonNegativeInteger(count);
  return states.includes(status.state as ProjectIndexState) &&
    typeof status.searchable === "boolean" &&
    (status.ownerPid === null || positiveInteger(status.ownerPid)) &&
    finiteNonNegativeInteger(status.generation) &&
    phases.includes(status.phase as ProjectIndexPhase) &&
    (status.progress === null || (
      !!status.progress && finiteNonNegativeInteger(status.progress.completed) &&
      finiteNonNegativeInteger(status.progress.total) &&
      status.progress.completed <= status.progress.total
    )) && nullableCount(status.files) && nullableCount(status.sourceChunks) &&
    nullableCount(status.embeddedWindows) &&
    nullableCount(status.factDocuments) &&
    nullableCount(status.embeddedFacts) &&
    nullableCount(status.relationDocuments) &&
    nullableCount(status.embeddedRelations) &&
    (status.lastUpdatedAt === null || typeof status.lastUpdatedAt === "string") &&
    (status.error === null || (
      !!status.error && typeof status.error.code === "string" &&
      typeof status.error.message === "string" &&
      typeof status.error.retryable === "boolean"
    ));
}

function isSharedStatus(value: unknown): value is SharedProjectStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<SharedProjectStatus>;
  return status.version === 2 &&
    positiveInteger(status.sourceIndexSchemaVersion) &&
    typeof status.root === "string" &&
    !!status.owner && typeof status.owner.instanceId === "string" &&
    /^[a-zA-Z0-9_-]+$/.test(status.owner.instanceId) &&
    positiveInteger(status.owner.pid) &&
    typeof status.owner.acquiredAt === "string" &&
    isIndexStatus(status.index) &&
    isDomainStatuses(status.domains) &&
    (status.preparation === null || isPreparation(status.preparation)) &&
    (status.config === null || isConfig(status.config));
}

export function projectIndexDomainStatuses(
  root: string,
  config: IndexConfig | null,
  status: ProjectIndexStatus,
): ProjectIndexDomainStatuses {
  const domains = indexDomains(config ?? {
    include: [],
    exclude: [],
  }, root);
  const resolved = (directories: readonly string[]): string[] =>
    directories.map((directory) => resolve(root, directory));
  const disabled = (
    directories: readonly string[],
    unimplemented = false,
  ): ProjectIndexDomainStatus => ({
    state: directories.length === 0
      ? "disabled"
      : (unimplemented ? "not-implemented" : status.state),
    directories: resolved(directories),
    generation: unimplemented ? 0 : status.generation,
    phase: null,
    progress: null,
    lastUpdatedAt: unimplemented ? null : status.lastUpdatedAt,
    error: null,
  });
  const source = disabled(domains.source.directories);
  if (source.state !== "disabled") {
    source.phase = status.phase;
    source.progress = status.progress ? { ...status.progress } : null;
    source.error = status.error;
  }
  return {
    source,
    history: disabled(domains.history.directories, true),
    conversations: disabled(domains.conversations.directories, true),
  };
}

/** Read the last atomically persisted project status. */
export async function readSharedProjectStatus(
  directory: string,
): Promise<SharedProjectStatus | null> {
  const layout = projectLayout(directory);
  try {
    const parsed: unknown = JSON.parse(await readFile(layout.statusPath, "utf8"));
    if (!isSharedStatus(parsed)) return null;
    const statusRoot = projectLayout(parsed.root).root;
    if (statusRoot !== layout.root) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist status without exposing a partially-written JSON document. */
export async function writeSharedProjectStatus(
  directory: string,
  status: SharedProjectStatus,
): Promise<void> {
  const layout = projectLayout(directory);
  await ensureProjectState(layout);
  const statusRoot = projectLayout(status.root).root;
  if (statusRoot !== layout.root) {
    throw new Error(
      `index status root ${statusRoot} does not match project ${layout.root}`,
    );
  }
  const path = layout.statusPath;
  const temporary = `${path}.${status.owner.instanceId}.tmp`;
  await mkdir(layout.stateDirectory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function initialProjectIndexStatus(): ProjectIndexStatus {
  return {
    state: "preparing",
    searchable: false,
    ownerPid: null,
    generation: 0,
    phase: "ownership",
    progress: null,
    files: null,
    sourceChunks: null,
    embeddedWindows: null,
    factDocuments: null,
    embeddedFacts: null,
    relationDocuments: null,
    embeddedRelations: null,
    lastUpdatedAt: null,
    error: null,
  };
}
