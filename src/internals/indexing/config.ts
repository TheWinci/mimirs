import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { z } from "zod";

import {
  canonicalPath,
  ensureProjectState,
  projectLayout,
} from "../project/layout.ts";

const globList = z.array(z.string().min(1)).transform((patterns) =>
  patterns.map((pattern) => pattern.replaceAll("\\", "/"))
);

const directoryList = z.array(z.string().min(1)).transform((directories) =>
  [...new Set(directories.map((directory) =>
    directory.replaceAll("\\", "/").replace(/\/$/, "") || "."
  ))]
);

const indexDomainsSchema = z.object({
  source: z.object({
    directories: z.array(z.string().min(1)),
  }).strict().optional(),
  history: z.object({
    provider: z.literal("git").optional(),
    directories: directoryList,
  }).strict().optional(),
  conversations: z.object({ directories: directoryList }).strict().optional(),
}).strict();

const indexConfigSchema = z.object({
  include: globList.optional(),
  exclude: globList.optional(),
  generated: globList.optional(),
  index: indexDomainsSchema.optional(),
}).strict();

export interface IndexDomainsConfig {
  source: { directories: readonly string[] };
  history: { provider: "git"; directories: readonly string[] };
  conversations: { directories: readonly string[] };
}

export interface IndexConfig {
  include: readonly string[];
  exclude: readonly string[];
  /** Optional project-relative globs for searchable but lower-priority files. */
  generated?: readonly string[];
  index?: IndexDomainsConfig;
}

const DEFAULT_INCLUDE = Object.freeze(["**/*"]);
const DEFAULT_EXCLUDE = Object.freeze([
  "**/.git/**",
  "**/.mimirs/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.output/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/.parcel-cache/**",
  "**/.webpack/**",
  "**/.nyc_output/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.tox/**",
  "**/*.egg-info/**",
  "**/target/**",
  "**/.idea/**",
  "**/.vscode/**",
  "**/.gitkeep",
  "**/.keep",
  "**/.DS_Store",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.p12",
  "**/id_rsa",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/id_ed25519",
  "**/.npmrc",
  "**/.pgpass",
  "**/.netrc",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.bundle.js",
  "**/*.chunk.js",
]);

export class IndexConfigError extends Error {
  constructor(
    readonly configPath: string,
    message: string,
  ) {
    super(`invalid index config ${configPath}: ${message}`);
    this.name = "IndexConfigError";
  }
}

export class ProjectNotInitializedError extends Error {
  constructor(readonly directory: string) {
    super(
      `Mimirs is not initialized for ${directory}; run \`mimirs init -d ${
        JSON.stringify(directory)
      }\` first`,
    );
    this.name = "ProjectNotInitializedError";
  }
}

/** Materialize complete defaults for one canonical source directory. */
export function defaultIndexConfig(directory: string): IndexConfig {
  const root = projectLayout(directory).root;
  return {
    include: [...DEFAULT_INCLUDE],
    exclude: [...DEFAULT_EXCLUDE],
    generated: [],
    index: {
      source: { directories: [root] },
      history: { provider: "git", directories: [] },
      conversations: { directories: [] },
    },
  };
}

/** Materialize complete defaults without replacing a concurrently-created file. */
export async function createDefaultIndexConfigIfMissing(
  directory: string,
): Promise<boolean> {
  const layout = projectLayout(directory);
  await ensureProjectState(layout);
  const path = layout.configPath;
  if (await Bun.file(path).exists()) return false;
  const temporary = `${path}.default.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(layout.stateDirectory, { recursive: true });
  const candidate = await open(temporary, "wx", 0o600);
  try {
    await candidate.writeFile(
      `${JSON.stringify(defaultIndexConfig(layout.root), null, 2)}\n`,
      "utf8",
    );
    await candidate.sync();
  } finally {
    await candidate.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function indexDomains(
  config: IndexConfig,
  root = ".",
): IndexDomainsConfig {
  return config.index ?? {
    source: { directories: [root] },
    history: { provider: "git", directories: [] },
    conversations: { directories: [] },
  };
}

export function isIndexDomainEnabled(
  config: IndexConfig,
  domain: keyof IndexDomainsConfig,
): boolean {
  if (!config.index) return domain === "source";
  return config.index[domain].directories.length > 0;
}

function validateGlobs(configPath: string, config: IndexConfig): void {
  for (const field of ["include", "exclude", "generated"] as const) {
    const patterns = config[field] ?? [];
    for (let index = 0; index < patterns.length; index++) {
      const pattern = patterns[index]!;
      try {
        new Bun.Glob(pattern);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new IndexConfigError(
          configPath,
          `${field}.${index}: invalid glob ${JSON.stringify(pattern)} (${message})`,
        );
      }
    }
  }
}

function validateSourceDirectory(
  configPath: string,
  root: string,
  directories: readonly string[],
): string {
  if (directories.length !== 1) {
    throw new IndexConfigError(
      configPath,
      "index.source.directories must contain exactly one absolute path",
    );
  }
  const configured = directories[0]!;
  if (!isAbsolute(configured)) {
    throw new IndexConfigError(
      configPath,
      "index.source.directories.0 must be an absolute path",
    );
  }
  const canonical = canonicalPath(configured);
  if (canonical !== root) {
    throw new IndexConfigError(
      configPath,
      `index.source.directories.0 must match the initialized project ${root}`,
    );
  }
  return canonical;
}

/** Load strict project config without creating it. Missing config uses defaults. */
export async function loadIndexConfig(directory: string): Promise<IndexConfig> {
  const layout = projectLayout(directory);
  const configPath = layout.configPath;
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultIndexConfig(layout.root);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IndexConfigError(configPath, message);
  }

  const parsed = indexConfigSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "config";
      return `${path}: ${issue.message}`;
    }).join(", ");
    throw new IndexConfigError(configPath, message);
  }

  const sourceDirectory = validateSourceDirectory(
    configPath,
    layout.root,
    parsed.data.index?.source?.directories ?? [],
  );
  const config: IndexConfig = {
    include: parsed.data.include ?? [...DEFAULT_INCLUDE],
    exclude: parsed.data.exclude ?? [...DEFAULT_EXCLUDE],
    generated: parsed.data.generated ?? [],
    index: {
      source: { directories: [sourceDirectory] },
      history: {
        provider: parsed.data.index?.history?.provider ?? "git",
        directories: parsed.data.index?.history?.directories ?? [],
      },
      conversations: {
        directories: parsed.data.index?.conversations?.directories ?? [],
      },
    },
  };
  validateGlobs(configPath, config);
  return config;
}

/** Require explicit initialization before a stateful CLI operation. */
export async function loadInitializedIndexConfig(
  directory: string,
): Promise<IndexConfig> {
  const layout = projectLayout(directory);
  if (!(await Bun.file(layout.configPath).exists())) {
    throw new ProjectNotInitializedError(layout.root);
  }
  return loadIndexConfig(layout.root);
}
