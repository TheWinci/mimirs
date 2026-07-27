import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export interface ProjectLayout {
  root: string;
  /** Writable host selected by `--state-dir`, or the project root by default. */
  stateHost: string;
  /** Mimirs-owned state directory below the host. */
  stateDirectory: string;
  configPath: string;
  databasePath: string;
  lockPath: string;
  statusPath: string;
  identityPath: string;
  externalState: boolean;
}

interface ProjectStateIdentity {
  version: 1;
  root: string;
}

export class ProjectStateMismatchError extends Error {
  constructor(
    readonly stateDirectory: string,
    readonly expectedRoot: string,
    readonly actualRoot: string,
  ) {
    super(
      `project state directory ${stateDirectory} belongs to ${actualRoot}; ` +
        `it cannot be reused for ${expectedRoot}`,
    );
    this.name = "ProjectStateMismatchError";
  }
}

export class ProjectStateIdentityError extends Error {
  constructor(readonly identityPath: string, message: string) {
    super(`invalid project state identity ${identityPath}: ${message}`);
    this.name = "ProjectStateIdentityError";
  }
}

export class UnboundProjectStateError extends Error {
  constructor(readonly stateDirectory: string, readonly collisions: string[]) {
    super(
      `unbound external project state ${stateDirectory} already contains ` +
        `Mimirs-owned files: ${collisions.join(", ")}`,
    );
    this.name = "UnboundProjectStateError";
  }
}

export class ProjectStateLocationError extends Error {
  constructor(readonly stateHost: string, readonly root: string) {
    super(
      `external project state host ${stateHost} must be outside ${root}; ` +
        `pass ${root} or omit --state-dir to use ${join(root, ".mimirs")}`,
    );
    this.name = "ProjectStateLocationError";
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return absolute;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function contains(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

export function projectLayout(
  directory: string,
  stateDirectory?: string,
): ProjectLayout {
  const root = canonicalPath(directory);
  const stateHost = stateDirectory === undefined
    ? root
    : canonicalPath(stateDirectory);
  const externalState = stateHost !== root;
  const state = canonicalPath(join(stateHost, ".mimirs"));
  if (
    externalState &&
    (contains(root, stateHost) || contains(root, state))
  ) {
    throw new ProjectStateLocationError(stateHost, root);
  }
  return {
    root,
    stateHost,
    stateDirectory: state,
    configPath: join(state, "config.json"),
    databasePath: join(state, "index.sqlite"),
    lockPath: join(state, "index.lock"),
    statusPath: join(state, "status.json"),
    identityPath: join(state, "project.json"),
    externalState,
  };
}

const MIMIRS_OWNED_WITHOUT_IDENTITY = [
  /^config\.json(?:\.|$)/,
  /^index\.sqlite(?:-|$)/,
  /^index\.lock(?:\.|$)/,
  /^status\.json(?:\.|$)/,
];

async function externalStateCanBeBound(
  layout: ProjectLayout,
): Promise<boolean> {
  if (!layout.externalState) return true;
  const entries = await readdir(layout.stateDirectory);
  const collisions = entries
    .filter((entry) =>
      MIMIRS_OWNED_WITHOUT_IDENTITY.some((pattern) => pattern.test(entry))
    )
    .sort((left, right) => left.localeCompare(right));
  if (collisions.length > 0) {
    // Another process may have bound the directory after our first identity
    // read and then started creating owned files. Re-check before rejecting it.
    const identity = await readIdentity(layout);
    if (identity) {
      assertIdentity(layout, identity);
      return false;
    }
    throw new UnboundProjectStateError(layout.stateDirectory, collisions);
  }
  return true;
}

function parseIdentity(path: string, raw: string): ProjectStateIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProjectStateIdentityError(path, message);
  }
  if (
    !value || typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { root?: unknown }).root !== "string"
  ) {
    throw new ProjectStateIdentityError(path, "expected version 1 and a root path");
  }
  return value as ProjectStateIdentity;
}

async function readIdentity(
  layout: ProjectLayout,
): Promise<ProjectStateIdentity | null> {
  try {
    return parseIdentity(
      layout.identityPath,
      await readFile(layout.identityPath, "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertIdentity(
  layout: ProjectLayout,
  identity: ProjectStateIdentity,
): void {
  const actualRoot = canonicalPath(identity.root);
  if (actualRoot !== layout.root) {
    throw new ProjectStateMismatchError(
      layout.stateDirectory,
      layout.root,
      actualRoot,
    );
  }
}

/** Validate an existing state identity without writing anything. */
export async function validateProjectState(
  layout: ProjectLayout,
  required = layout.externalState,
): Promise<void> {
  const identity = await readIdentity(layout);
  if (!identity) {
    if (required) {
      throw new ProjectStateIdentityError(
        layout.identityPath,
        "the external state directory has not been initialized for this project",
      );
    }
    return;
  }
  assertIdentity(layout, identity);
}

/** Create or validate the durable one-project-per-state-directory identity. */
export async function ensureProjectState(layout: ProjectLayout): Promise<void> {
  await mkdir(layout.stateDirectory, { recursive: true });
  const existing = await readIdentity(layout);
  if (existing) {
    assertIdentity(layout, existing);
    return;
  }
  if (!(await externalStateCanBeBound(layout))) return;

  const temporary = `${layout.identityPath}.${process.pid}.${randomUUID()}.tmp`;
  const candidate = await open(temporary, "wx", 0o600);
  try {
    const identity: ProjectStateIdentity = { version: 1, root: layout.root };
    await candidate.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8");
    await candidate.sync();
  } finally {
    await candidate.close();
  }
  try {
    await link(temporary, layout.identityPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const identity = await readIdentity(layout);
  if (!identity) {
    throw new ProjectStateIdentityError(
      layout.identityPath,
      "identity disappeared while it was being created",
    );
  }
  assertIdentity(layout, identity);
}
