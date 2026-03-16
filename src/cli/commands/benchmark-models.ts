import { resolve, join } from "path";
import { mkdirSync, rmSync, existsSync } from "fs";
import { RagDB } from "../../db";
import { loadConfig, applyEmbeddingConfig } from "../../config";
import { indexDirectory } from "../../indexing/indexer";
import { loadBenchmarkQueries, runBenchmark, type BenchmarkSummary } from "../../search/benchmark";
import { configureEmbedder, resetEmbedder, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../../embeddings/embed";

interface ModelSpec {
  id: string;
  dim: number;
}

const KNOWN_MODELS: Record<string, ModelSpec> = {
  "Xenova/all-MiniLM-L6-v2": { id: "Xenova/all-MiniLM-L6-v2", dim: 384 },
  "Xenova/bge-small-en-v1.5": { id: "Xenova/bge-small-en-v1.5", dim: 384 },
  "Xenova/jina-embeddings-v2-small-en": { id: "Xenova/jina-embeddings-v2-small-en", dim: 512 },
  "jinaai/jina-embeddings-v2-base-code": { id: "jinaai/jina-embeddings-v2-base-code", dim: 768 },
};

function parseModelArg(arg: string): ModelSpec {
  if (KNOWN_MODELS[arg]) return KNOWN_MODELS[arg];
  // Allow model:dim format for unknown models
  const parts = arg.split(":");
  if (parts.length === 2) {
    return { id: parts[0], dim: parseInt(parts[1], 10) };
  }
  throw new Error(`Unknown model "${arg}". Use a known model or specify as "model-id:dim". Known models: ${Object.keys(KNOWN_MODELS).join(", ")}`);
}

export async function benchmarkModelsCommand(args: string[], getFlag: (flag: string) => string | undefined) {
  const file = args[1];
  if (!file) {
    console.error("Usage: local-rag benchmark-models <queries.json> --models model1,model2 [--dir D] [--top N]");
    console.error("\nKnown models:");
    for (const [name, spec] of Object.entries(KNOWN_MODELS)) {
      console.error(`  ${name} (${spec.dim}d)`);
    }
    process.exit(1);
  }

  const dir = resolve(getFlag("--dir") || ".");
  const config = await loadConfig(dir);
  const top = parseInt(getFlag("--top") || String(config.benchmarkTopK), 10);
  const modelsArg = getFlag("--models");

  if (!modelsArg) {
    console.error("Error: --models is required. Example: --models Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5");
    process.exit(1);
  }

  const models = modelsArg.split(",").map(parseModelArg);
  const queries = await loadBenchmarkQueries(resolve(file));
  const results: { model: ModelSpec; summary: BenchmarkSummary; indexTimeMs: number }[] = [];

  console.log(`Comparing ${models.length} models on ${queries.length} queries (top-${top})...\n`);

  for (const model of models) {
    console.log(`\n--- ${model.id} (${model.dim}d) ---`);

    // Configure the embedder for this model
    configureEmbedder(model.id, model.dim);
    resetEmbedder();

    // Create a temporary DB for this model
    const tmpDir = join(dir, `.rag-eval-${model.id.replace(/\//g, "-")}`);
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });

    // Create a temp config pointing at this temp dir
    const tmpRagDir = tmpDir;
    const db = new RagDB(dir, tmpRagDir);

    try {
      // Index
      console.log("  Indexing...");
      const indexStart = performance.now();
      const indexResult = await indexDirectory(dir, db, config, (msg) => {
        process.stdout.write(`\r  ${msg}`);
      });
      const indexTimeMs = Math.round(performance.now() - indexStart);
      console.log(`\n  Indexed ${indexResult.indexed} files in ${(indexTimeMs / 1000).toFixed(1)}s`);

      // Benchmark
      console.log("  Running benchmark...");
      const summary = await runBenchmark(queries, db, dir, top, config.hybridWeight);

      results.push({ model, summary, indexTimeMs });

      console.log(`  Recall@${top}: ${(summary.recallAtK * 100).toFixed(1)}%`);
      console.log(`  MRR: ${summary.mrr.toFixed(3)}`);
      console.log(`  Zero-miss: ${(summary.zeroMissRate * 100).toFixed(1)}%`);
    } finally {
      db.close();
      // Clean up temp DB
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Restore default embedder
  configureEmbedder(DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM);
  resetEmbedder();

  // Print comparison table
  console.log("\n\n=== Comparison ===\n");
  const header = `| Model | Dim | Recall@${top} | MRR | Zero-miss | Index time |`;
  const sep = "|---|---|---|---|---|---|";
  console.log(header);
  console.log(sep);
  for (const r of results) {
    const recall = `${(r.summary.recallAtK * 100).toFixed(1)}%`;
    const mrr = r.summary.mrr.toFixed(3);
    const zeroMiss = `${(r.summary.zeroMissRate * 100).toFixed(1)}%`;
    const indexTime = `${(r.indexTimeMs / 1000).toFixed(1)}s`;
    console.log(`| ${r.model.id} | ${r.model.dim} | ${recall} | ${mrr} | ${zeroMiss} | ${indexTime} |`);
  }

  // Check if any candidate beats the baseline by >5%
  if (results.length > 1) {
    const baseline = results[0];
    for (let i = 1; i < results.length; i++) {
      const candidate = results[i];
      const recallDiff = (candidate.summary.recallAtK - baseline.summary.recallAtK) * 100;
      const mrrDiff = candidate.summary.mrr - baseline.summary.mrr;
      console.log(`\n${candidate.model.id} vs ${baseline.model.id}:`);
      console.log(`  Recall: ${recallDiff >= 0 ? "+" : ""}${recallDiff.toFixed(1)}pp`);
      console.log(`  MRR: ${mrrDiff >= 0 ? "+" : ""}${mrrDiff.toFixed(3)}`);
      if (recallDiff > 5) {
        console.log(`  → Candidate shows >5pp recall improvement — consider making it default`);
      } else if (recallDiff > 0) {
        console.log(`  → Marginal improvement — document but keep current default`);
      } else {
        console.log(`  → No recall improvement`);
      }
    }
  }
}
