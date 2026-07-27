import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";

import { z } from "zod";

import {
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

const sourceDirectoryList = z.array(z.string().min(1))
  .transform((directories) =>
    directories.map((directory) =>
      directory.replaceAll("\\", "/").replace(/\/$/, "") || "."
    )
  )
  .pipe(
    z.array(z.literal(".")).max(
      1,
      "source indexing currently supports only the project root",
    ),
  );

const indexDomainsSchema = z.object({
  source: z.object({ directories: sourceDirectoryList }).strict().optional(),
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
  /** Desired project-local index domains. Presence of `.` enables a domain. */
  index?: IndexDomainsConfig;
}

export const DEFAULT_INDEX_CONFIG: Readonly<IndexConfig> = Object.freeze({
  include: Object.freeze(["**/*"]),
  exclude: Object.freeze([
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
  ]),
  generated: Object.freeze([]),
  index: Object.freeze({
    source: Object.freeze({ directories: Object.freeze(["."]) }),
    history: Object.freeze({
      provider: "git" as const,
      directories: Object.freeze([]),
    }),
    conversations: Object.freeze({ directories: Object.freeze([]) }),
  }),
});

export class IndexConfigError extends Error {
  constructor(
    readonly configPath: string,
    message: string,
  ) {
    super(`invalid index config ${configPath}: ${message}`);
    this.name = "IndexConfigError";
  }
}

function copyDefaults(): IndexConfig {
  return {
    include: [...DEFAULT_INDEX_CONFIG.include],
    exclude: [...DEFAULT_INDEX_CONFIG.exclude],
    generated: [...(DEFAULT_INDEX_CONFIG.generated ?? [])],
    index: {
      source: { directories: ["."] },
      history: { provider: "git", directories: [] },
      conversations: { directories: [] },
    },
  };
}

/** Materialize complete defaults without replacing a concurrently-created file. */
export async function createDefaultIndexConfigIfMissing(
  directory: string,
  stateDirectory?: string,
): Promise<boolean> {
  const layout = projectLayout(directory, stateDirectory);
  await ensureProjectState(layout);
  const path = layout.configPath;
  // Avoid emitting a temporary-file watcher event when defaults already exist.
  // The link below still arbitrates concurrent first-time creators safely.
  if (await Bun.file(path).exists()) return false;
  const temporary = `${path}.default.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(layout.stateDirectory, { recursive: true });
  const candidate = await open(temporary, "wx", 0o600);
  try {
    await candidate.writeFile(`${JSON.stringify(copyDefaults(), null, 2)}\n`, "utf8");
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

export function indexDomains(config: IndexConfig): IndexDomainsConfig {
  return config.index ?? copyDefaults().index!;
}

export function isIndexDomainEnabled(
  config: IndexConfig,
  domain: keyof IndexDomainsConfig,
): boolean {
  return indexDomains(config)[domain].directories.length > 0;
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

/** Load an optional, strict state-directory config without creating it. */
export async function loadIndexConfig(
  directory: string,
  stateDirectory?: string,
): Promise<IndexConfig> {
  const configPath = projectLayout(directory, stateDirectory).configPath;
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return copyDefaults();
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

  const config = {
    include: parsed.data.include ?? [...DEFAULT_INDEX_CONFIG.include],
    exclude: parsed.data.exclude ?? [...DEFAULT_INDEX_CONFIG.exclude],
    generated: parsed.data.generated ?? [...(DEFAULT_INDEX_CONFIG.generated ?? [])],
    index: {
      source: {
        directories: parsed.data.index?.source?.directories ?? ["."],
      },
      history: {
        provider: parsed.data.index?.history?.provider ?? "git" as const,
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


/** Atomically persist one project-local domain's desired enabled state. */
export async function setIndexDomainEnabled(
  directory: string,
  domain: keyof IndexDomainsConfig,
  enabled: boolean,
  stateDirectory?: string,
): Promise<IndexConfig> {
  const layout = projectLayout(directory, stateDirectory);
  await ensureProjectState(layout);
  const config = await loadIndexConfig(layout.root, layout.stateHost);
  const domains = indexDomains(config);
  const next: IndexConfig = {
    include: [...config.include],
    exclude: [...config.exclude],
    generated: [...(config.generated ?? [])],
    index: {
      source: {
        directories: domain === "source"
          ? (enabled ? ["."] : [])
          : [...domains.source.directories],
      },
      history: {
        provider: "git",
        directories: domain === "history"
          ? (enabled ? ["."] : [])
          : [...domains.history.directories],
      },
      conversations: {
        directories: domain === "conversations"
          ? (enabled ? ["."] : [])
          : [...domains.conversations.directories],
      },
    },
  };
  const path = layout.configPath;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(layout.stateDirectory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return next;
}
