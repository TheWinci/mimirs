import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { z } from "zod";
import { log } from "../utils/log";
import { configureEmbedder, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../embeddings/embed";

// Glob patterns are POSIX-style — `\` is an escape character in glob syntax,
// not a path separator. If a Windows user writes `node_modules\**`, treat
// the `\` as a path separator and rewrite to `/`. Defense-in-depth: the
// indexer also normalizes paths at the storage boundary.
const globList = z
  .array(z.string())
  .default([])
  .transform((arr) => arr.map((p) => p.replaceAll("\\", "/")));

const RagConfigSchema = z.object({
  include: globList,
  exclude: globList,
  generated: globList,
  chunkSize: z.number().int().min(64).default(512),
  chunkOverlap: z.number().int().min(0).default(50),
  hybridWeight: z.number().min(0).max(1).default(0.5),
  searchTopK: z.number().int().min(1).default(8),
  indexBatchSize: z.number().int().min(1).optional(),
  indexThreads: z.number().int().min(1).optional(),
  incrementalChunks: z.boolean().default(false),
  embeddingMerge: z.boolean().default(true),
  embeddingModel: z.string().optional(),
  embeddingDim: z.number().int().min(1).optional(),
  embeddingRevision: z.string().optional(),
  embeddingPooling: z.enum(["mean", "cls", "none"]).optional(),
  embeddingDtype: z.string().optional(),
  parentGroupingMinCount: z.number().int().min(2).default(2),
  // read_relevant returns tight leaf (function-level) chunks instead of promoted
  // whole-class/file parent chunks — far lower token cost, same coverage, better
  // line precision. Default on: it's strictly better for agent consumers (proven
  // ~0.4x token cost at equal answer quality). Set false to restore parent chunks.
  leafOnly: z.boolean().default(true),
  // Leaf-chunk re-rank tuning (read_relevant). Defaults are the measured ContextBench
  // line-metric peak: whole-class boost 0.3 (lift a leaf by its file's parent-blob
  // match), adaptive tail cut keeping chunks >= settled-anchor*0.85 (skip steep head
  // steps >15% so an inflated top doesn't set the bar too high). 0 disables a knob.
  chunkParentBoost: z.number().min(0).default(0.3),
  chunkRelCutoff: z.number().min(0).max(1).default(0.85),
  chunkSteepSkip: z.number().min(0).max(1).default(0.15),
  benchmarkTopK: z.number().int().min(1).default(5),
  benchmarkMinRecall: z.number().min(0).max(1).default(0.8),
  benchmarkMinMrr: z.number().min(0).max(1).default(0.6),
}).refine((c) => c.chunkOverlap < c.chunkSize, {
  // An overlap >= chunkSize stalls the size-splitter's sliding window (it would
  // loop forever). splitBySize also clamps defensively, but reject it here so a
  // bad config surfaces a warning and falls back to defaults instead.
  message: "chunkOverlap must be less than chunkSize",
  path: ["chunkOverlap"],
});

export type RagConfig = z.infer<typeof RagConfigSchema>;

const DEFAULT_CONFIG: RagConfig = {
  include: [
    // Source code — AST-aware chunking
    "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
    "**/*.py",
    "**/*.go",
    "**/*.rs",
    "**/*.java",
    "**/*.c", "**/*.h",
    "**/*.cpp", "**/*.cc", "**/*.cxx", "**/*.hpp", "**/*.hh", "**/*.hxx",
    "**/*.cs",
    "**/*.rb",
    "**/*.php",
    "**/*.scala", "**/*.sc",
    "**/*.kt", "**/*.kts",
    "**/*.lua",
    "**/*.zig", "**/*.zon",
    "**/*.ex", "**/*.exs",
    "**/*.hs", "**/*.lhs",
    "**/*.ml", "**/*.mli",
    // Source code — heuristic chunking
    "**/*.swift",
    // Markdown & plain text
    "**/*.md", "**/*.mdx", "**/*.markdown", "**/*.txt",
    // Build / task runners (no extension or prefix-named)
    "**/Makefile", "**/makefile", "**/GNUmakefile",
    "**/Dockerfile", "**/Dockerfile.*",
    "**/Jenkinsfile", "**/Jenkinsfile.*",
    "**/Vagrantfile", "**/Gemfile", "**/Rakefile",
    "**/Brewfile", "**/Procfile",
    // Shell & scripting
    "**/*.sh", "**/*.bash", "**/*.zsh", "**/*.fish",
    // Structured data & config
    "**/*.yaml", "**/*.yml",
    "**/*.toml",
    "**/*.xml",
    // Infrastructure / schema languages
    "**/*.tf",
    "**/*.proto",
    "**/*.graphql", "**/*.gql",
    "**/*.sql",
    "**/*.mod",
    // API collections
    "**/*.bru",
    // Stylesheets — not indexed by default (class names add noise to code search)
    // "**/*.css", "**/*.scss", "**/*.less",
  ],
  exclude: [
    // Package managers & dependencies
    "**/node_modules/**", ".yarn/**", ".pnp.*",
    // Version control
    ".git/**",
    // Build output & bundled/minified assets
    "dist/**", "build/**", "out/**", ".output/**",
    "*.min.js", "*.min.css", "*.bundle.js", "*.chunk.js",
    // Framework caches & generated
    ".next/**", ".nuxt/**", ".svelte-kit/**", ".turbo/**",
    // Tool caches
    ".cache/**", ".parcel-cache/**", ".webpack/**",
    // Test & coverage output
    "coverage/**", ".nyc_output/**",
    // Environment & secrets — `**/` so nested copies (services/api/.env) match too.
    // Defense-in-depth only: gitignored files are already skipped at collection;
    // this catches untracked-not-ignored secret files that would otherwise index.
    "**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.pfx", "**/*.p12",
    "**/id_rsa", "**/id_dsa", "**/id_ecdsa", "**/id_ed25519",
    "**/.npmrc", "**/.pgpass", "**/.netrc",
    // IDE settings (config, not code)
    ".idea/**", ".vscode/**",
    // Python
    "**/__pycache__/**", ".venv/**", "venv/**", ".tox/**", "*.egg-info/**",
    // Rust
    "target/**",
    // Go
    "**/vendor/**",
    // Mimirs index
    ".mimirs/**",
  ],
  generated: [],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.5,
  searchTopK: 8,
  incrementalChunks: false,
  embeddingMerge: true,
  parentGroupingMinCount: 2,
  leafOnly: true,
  chunkParentBoost: 0.3,
  chunkRelCutoff: 0.85,
  chunkSteepSkip: 0.15,
  indexBatchSize: 50,
  benchmarkTopK: 5,
  benchmarkMinRecall: 0.8,
  benchmarkMinMrr: 0.6,
};

/**
 * Load config from .mimirs/config.json.
 * If the file doesn't exist, writes the defaults there first so users can
 * edit the file directly — no hidden merge logic, what's on disk is what runs.
 */
export async function loadConfig(projectDir: string): Promise<RagConfig> {
  const ragDir = join(projectDir, ".mimirs");
  const configPath = join(ragDir, "config.json");

  if (!existsSync(configPath)) {
    await mkdir(ragDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`Invalid JSON in ${configPath}, using defaults`, "config");
    return { ...DEFAULT_CONFIG };
  }

  const result = RagConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    log.warn(`Config validation: ${issues}. Using defaults for invalid fields.`, "config");
    return { ...DEFAULT_CONFIG };
  }

  // The glob lists default to [] when omitted, which would index nothing. A
  // valid config that just sets, say, chunkSize should still inherit the
  // default include/exclude globs (an explicit `[]` is respected).
  const obj = parsed as Record<string, unknown>;
  if (!("include" in obj)) result.data.include = DEFAULT_CONFIG.include;
  if (!("exclude" in obj)) result.data.exclude = DEFAULT_CONFIG.exclude;

  return result.data;
}

/**
 * A project-local `.mimirs/config.json` is attacker-controllable: a cloned repo
 * can ship one (it isn't gitignored in the victim's checkout). Honoring an
 * arbitrary `embeddingModel` from it lets a malicious repo choose which model
 * mimirs downloads on first index/query. Gate any non-default model behind an
 * explicit opt-in env flag; otherwise ignore the custom model (and the dim/
 * pooling/dtype/revision that go with it) and fall back to the pinned default.
 */
function allowCustomModel(): boolean {
  return process.env.MIMIRS_ALLOW_CUSTOM_MODEL === "1";
}

interface ResolvedModel {
  model: string;
  dim: number;
  pooling?: "mean" | "cls" | "none";
  dtype?: string;
  revision?: string;
}

function resolveModel(c: {
  embeddingModel?: string;
  embeddingDim?: number;
  embeddingPooling?: "mean" | "cls" | "none";
  embeddingDtype?: string;
  embeddingRevision?: string;
}): ResolvedModel {
  const requested = c.embeddingModel;
  if (requested && requested !== DEFAULT_MODEL_ID && !allowCustomModel()) {
    log.warn(
      `Ignoring embeddingModel="${requested}" from project config (untrusted). ` +
        `Set MIMIRS_ALLOW_CUSTOM_MODEL=1 to allow it. Using ${DEFAULT_MODEL_ID}.`,
      "config",
    );
    return { model: DEFAULT_MODEL_ID, dim: DEFAULT_EMBEDDING_DIM };
  }
  // Default model, or a custom model the operator opted into. The custom dim/
  // pooling/dtype/revision are only honored alongside an honored custom model.
  return {
    model: requested ?? DEFAULT_MODEL_ID,
    dim: c.embeddingDim ?? DEFAULT_EMBEDDING_DIM,
    pooling: c.embeddingPooling,
    dtype: c.embeddingDtype,
    revision: c.embeddingRevision,
  };
}

/**
 * Apply embedding model settings from config.
 * Call this after loadConfig() when embeddings will be used.
 */
export function applyEmbeddingConfig(config: RagConfig): void {
  const r = resolveModel(config);
  configureEmbedder(r.model, r.dim, r.pooling, r.dtype, r.revision);
}

/**
 * Synchronously apply the embedding model/dim from a project's config.json.
 *
 * Called inside the `RagDB` constructor so the vec tables are always created at
 * the configured dimension — the constructor must run before `initSchema`, and
 * it is synchronous, so it cannot await `loadConfig`. Reads only the embedding
 * fields (best-effort) and never writes the file; the async `loadConfig` owns
 * writing defaults and validation warnings. Missing/invalid config falls back
 * to the default model + dim.
 */
export function applyEmbeddingConfigFromDisk(projectDir: string): void {
  const configPath = join(projectDir, ".mimirs", "config.json");
  const fields: {
    embeddingModel?: string;
    embeddingDim?: number;
    embeddingPooling?: "mean" | "cls" | "none";
    embeddingDtype?: string;
    embeddingRevision?: string;
  } = {};

  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
        embeddingModel?: unknown;
        embeddingDim?: unknown;
        embeddingPooling?: unknown;
        embeddingDtype?: unknown;
        embeddingRevision?: unknown;
      };
      if (typeof parsed.embeddingModel === "string") fields.embeddingModel = parsed.embeddingModel;
      if (Number.isInteger(parsed.embeddingDim) && (parsed.embeddingDim as number) > 0) {
        fields.embeddingDim = parsed.embeddingDim as number;
      }
      if (parsed.embeddingPooling === "mean" || parsed.embeddingPooling === "cls" || parsed.embeddingPooling === "none") {
        fields.embeddingPooling = parsed.embeddingPooling;
      }
      if (typeof parsed.embeddingDtype === "string") fields.embeddingDtype = parsed.embeddingDtype;
      if (typeof parsed.embeddingRevision === "string") fields.embeddingRevision = parsed.embeddingRevision;
    } catch {
      // Malformed JSON — fall back to defaults; loadConfig() surfaces the warning.
    }
  }

  // Same untrusted-config gate as applyEmbeddingConfig: a non-default model is
  // ignored unless MIMIRS_ALLOW_CUSTOM_MODEL=1.
  const r = resolveModel(fields);
  configureEmbedder(r.model, r.dim, r.pooling, r.dtype, r.revision);
}
