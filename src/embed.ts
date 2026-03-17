import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync } from "node:fs";

// Use a stable cache directory so models survive bunx temp dir cleanup
const CACHE_DIR = join(homedir(), ".cache", "local-rag-mcp", "models");
env.cacheDir = CACHE_DIR;

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

let extractor: FeatureExtractionPipeline | null = null;

export async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    try {
      extractor = await pipeline("feature-extraction", MODEL_ID, {
        dtype: "fp32",
      });
    } catch (err) {
      // If the cached model is corrupted, delete it and retry once
      const msg = (err as Error).message || "";
      if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
        const modelDir = join(CACHE_DIR, ...MODEL_ID.split("/"));
        rmSync(modelDir, { recursive: true, force: true });
        extractor = await pipeline("feature-extraction", MODEL_ID, {
          dtype: "fp32",
        });
      } else {
        throw err;
      }
    }
  }
  return extractor;
}

export async function embed(text: string): Promise<Float32Array> {
  const model = await getEmbedder();
  const output = await model(text, { pooling: "mean", normalize: true });
  return new Float32Array(output.data as Float64Array);
}

export { EMBEDDING_DIM };
