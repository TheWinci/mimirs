import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface RagConfig {
  include: string[];
  exclude: string[];
  chunkSize: number;
  chunkOverlap: number;
  hybridWeight: number; // 0-1: 1 = vector only, 0 = BM25 only, 0.7 = default blend
  searchTopK: number; // default number of results for search
  indexBatchSize?: number; // chunks to embed per batch before yielding to event loop (default: 50)
  indexThreads?: number; // ONNX inference threads for embedding (default: cpus/3, min 2)
  benchmarkTopK: number; // default top-K for benchmark runs
  benchmarkMinRecall: number; // minimum Recall@K to pass (0-1)
  benchmarkMinMrr: number; // minimum MRR to pass (0-1)
}

const DEFAULT_CONFIG: RagConfig = {
  include: [
    // Markdown & plain text
    "**/*.md", "**/*.txt",
    // Build / task runners (no extension or prefix-named)
    "**/Makefile", "**/makefile", "**/GNUmakefile",
    "**/Dockerfile", "**/Dockerfile.*",
    "**/Jenkinsfile", "**/Jenkinsfile.*",
    "**/Vagrantfile", "**/Gemfile", "**/Rakefile",
    "**/Brewfile", "**/Procfile",
    // Structured data & config
    "**/*.yaml", "**/*.yml",
    "**/*.json",
    "**/*.toml",
    "**/*.xml",
    // Shell & scripting
    "**/*.sh", "**/*.bash", "**/*.zsh",
    // Infrastructure / schema languages
    "**/*.tf",
    "**/*.proto",
    "**/*.graphql", "**/*.gql",
    "**/*.sql",
    "**/*.mod",
    "**/*.bru",
    "**/*.css", "**/*.scss", "**/*.less",
  ],
  exclude: ["node_modules/**", ".git/**", "dist/**", ".rag/**"],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.7,
  searchTopK: 5,
  indexBatchSize: 50,
  benchmarkTopK: 5,
  benchmarkMinRecall: 0.8,
  benchmarkMinMrr: 0.6,
};

export async function loadConfig(projectDir: string): Promise<RagConfig> {
  const configPath = join(projectDir, ".rag", "config.json");

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(configPath, "utf-8");
  const userConfig = JSON.parse(raw);

  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
  };
}

export async function writeDefaultConfig(projectDir: string): Promise<string> {
  const ragDir = join(projectDir, ".rag");
  await mkdir(ragDir, { recursive: true });
  const configPath = join(ragDir, "config.json");
  await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return configPath;
}
