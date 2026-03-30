import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { z } from "zod";
import { log } from "../utils/log";
import { configureEmbedder, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../embeddings/embed";

const RagConfigSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  generated: z.array(z.string()).default([]),
  chunkSize: z.number().int().min(64).default(512),
  chunkOverlap: z.number().int().min(0).default(50),
  hybridWeight: z.number().min(0).max(1).default(0.7),
  searchTopK: z.number().int().min(1).default(10),
  indexBatchSize: z.number().int().min(1).optional(),
  indexThreads: z.number().int().min(1).optional(),
  incrementalChunks: z.boolean().default(false),
  embeddingMerge: z.boolean().default(true),
  embeddingModel: z.string().optional(),
  embeddingDim: z.number().int().min(1).optional(),
  parentGroupingMinCount: z.number().int().min(2).default(2),
  benchmarkTopK: z.number().int().min(1).default(5),
  benchmarkMinRecall: z.number().min(0).max(1).default(0.8),
  benchmarkMinMrr: z.number().min(0).max(1).default(0.6),
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
    "node_modules/**", ".yarn/**", ".pnp.*",
    // Version control
    ".git/**",
    // Build output
    "dist/**", "build/**", "out/**", ".output/**",
    // Framework caches & generated
    ".next/**", ".nuxt/**", ".svelte-kit/**", ".turbo/**",
    // Tool caches
    ".cache/**", ".parcel-cache/**", ".webpack/**",
    // Test & coverage output
    "coverage/**", ".nyc_output/**",
    // Environment & secrets
    ".env", ".env.*",
    // IDE settings (config, not code)
    ".idea/**", ".vscode/**",
    // Python
    "__pycache__/**", ".venv/**", "venv/**", ".tox/**", "*.egg-info/**",
    // Rust
    "target/**",
    // Go
    "vendor/**",
    // Local RAG index
    ".rag/**",
  ],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.7,
  searchTopK: 10,
  incrementalChunks: false,
  indexBatchSize: 50,
  benchmarkTopK: 5,
  benchmarkMinRecall: 0.8,
  benchmarkMinMrr: 0.6,
};

/**
 * Load config from .rag/config.json.
 * If the file doesn't exist, writes the defaults there first so users can
 * edit the file directly — no hidden merge logic, what's on disk is what runs.
 */
export async function loadConfig(projectDir: string): Promise<RagConfig> {
  const ragDir = join(projectDir, ".rag");
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

  return result.data;
}

/**
 * Apply embedding model settings from config.
 * Call this after loadConfig() when embeddings will be used.
 */
export function applyEmbeddingConfig(config: RagConfig): void {
  const model = config.embeddingModel ?? DEFAULT_MODEL_ID;
  const dim = config.embeddingDim ?? DEFAULT_EMBEDDING_DIM;
  configureEmbedder(model, dim);
}
