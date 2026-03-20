import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { join } from "node:path";
import { homedir, cpus } from "node:os";
import { rmSync } from "node:fs";

// Use a stable cache directory so models survive bunx temp dir cleanup
const CACHE_DIR = join(homedir(), ".cache", "local-rag-mcp", "models");
env.cacheDir = CACHE_DIR;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let extractor: FeatureExtractionPipeline | null = null;

function defaultThreadCount(): number {
  return Math.max(2, Math.floor(cpus().length / 3));
}

export async function getEmbedder(threads?: number): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    const numThreads = threads ?? defaultThreadCount();
    const pipelineOptions = {
      dtype: "fp32" as const,
      session_options: {
        intraOpNumThreads: numThreads,
        interOpNumThreads: numThreads,
      },
    };
    try {
      extractor = await pipeline("feature-extraction", MODEL_ID, pipelineOptions);
    } catch (err) {
      // If the cached model is corrupted, delete it and retry once
      const msg = (err as Error).message || "";
      if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
        const modelDir = join(CACHE_DIR, ...MODEL_ID.split("/"));
        rmSync(modelDir, { recursive: true, force: true });
        extractor = await pipeline("feature-extraction", MODEL_ID, pipelineOptions);
      } else {
        throw err;
      }
    }
  }
  return extractor;
}

export async function embed(text: string, threads?: number): Promise<Float32Array> {
  const model = await getEmbedder(threads);
  const output = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float64Array);
}

export async function embedBatch(texts: string[], threads?: number): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const model = await getEmbedder(threads);
  const output = await model(texts, { pooling: "mean", normalize: true });
  const flat = new Float32Array(output.data as Float64Array);
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
  }
  return result;
}

/** Reset the singleton — only for testing */
export function resetEmbedder(): void {
  extractor = null;
}

export { EMBEDDING_DIM };
