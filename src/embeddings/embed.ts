import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { join } from "node:path";
import { homedir, cpus } from "node:os";
import { rmSync } from "node:fs";

// Use a stable cache directory so models survive bunx temp dir cleanup
const CACHE_DIR = join(homedir(), ".cache", "local-rag", "models");
env.cacheDir = CACHE_DIR;

const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIM = 384;

let currentModelId = DEFAULT_MODEL_ID;
let currentDim = DEFAULT_EMBEDDING_DIM;
let extractor: FeatureExtractionPipeline | null = null;

function defaultThreadCount(): number {
  return Math.max(2, Math.floor(cpus().length / 3));
}

/**
 * Configure a different embedding model. Must be called before getEmbedder().
 * Resets the singleton if the model changes.
 */
export function configureEmbedder(modelId: string, dim: number): void {
  if (modelId !== currentModelId || dim !== currentDim) {
    extractor = null;
    currentModelId = modelId;
    currentDim = dim;
  }
}

export async function getEmbedder(
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    const numThreads = threads ?? defaultThreadCount();
    const pipelineOptions = {
      dtype: "q8" as const,
      session_options: {
        intraOpNumThreads: numThreads,
        interOpNumThreads: numThreads,
      },
    };
    onProgress?.(`Loading embedding model ${currentModelId}...`);
    try {
      extractor = await pipeline("feature-extraction", currentModelId, pipelineOptions);
    } catch (err) {
      // If the cached model is corrupted, delete it and retry once
      const msg = (err as Error).message || "";
      if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
        const modelDir = join(CACHE_DIR, ...currentModelId.split("/"));
        rmSync(modelDir, { recursive: true, force: true });
        onProgress?.(`Retrying model load (cache was corrupted)...`);
        extractor = await pipeline("feature-extraction", currentModelId, pipelineOptions);
      } else {
        throw err;
      }
    }
    onProgress?.(`Model loaded`);
  }
  return extractor;
}

export async function embed(
  text: string,
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<Float32Array> {
  const model = await getEmbedder(threads, onProgress);
  const output = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float64Array);
}

export async function embedBatch(
  texts: string[],
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const model = await getEmbedder(threads, onProgress);
  const output = await model(texts, { pooling: "mean", normalize: true });
  const flat = new Float32Array(output.data as Float64Array);
  const result: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    result.push(flat.slice(i * currentDim, (i + 1) * currentDim));
  }
  return result;
}

/** Reset the singleton — only for testing */
export function resetEmbedder(): void {
  extractor = null;
}

/** Current embedding dimension — changes if configureEmbedder() is called */
export function getEmbeddingDim(): number {
  return currentDim;
}

/** Current model ID */
export function getModelId(): string {
  return currentModelId;
}

// Backwards-compatible constant export (default dimension)
const EMBEDDING_DIM = DEFAULT_EMBEDDING_DIM;
export { EMBEDDING_DIM, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM };
