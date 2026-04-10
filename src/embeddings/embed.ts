import {
  env,
  pipeline,
  AutoTokenizer,
  type FeatureExtractionPipeline,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { join } from "node:path";
import { homedir, cpus } from "node:os";
import { rmSync } from "node:fs";

// Use a stable cache directory so models survive bunx temp dir cleanup
const CACHE_DIR = join(homedir(), ".cache", "mimirs", "models");
env.cacheDir = CACHE_DIR;

const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIM = 384;

const MODEL_MAX_TOKENS = 256;
const MERGE_WINDOW_OVERLAP = 32;

let currentModelId = DEFAULT_MODEL_ID;
let currentDim = DEFAULT_EMBEDDING_DIM;
let extractor: FeatureExtractionPipeline | null = null;
let tokenizer: PreTrainedTokenizer | null = null;

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
    tokenizer = null;
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
      // @ts-expect-error — pipeline() overload union is too complex for tsc
      extractor = await pipeline("feature-extraction", currentModelId, pipelineOptions);
    } catch (err) {
      // If the cached model is corrupted, delete it and retry once
      const msg = (err as Error).message || "";
      if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
        const modelDir = join(CACHE_DIR, ...currentModelId.split("/"));
        rmSync(modelDir, { recursive: true, force: true });
        onProgress?.(`Retrying model load (cache was corrupted)...`);
        extractor = await pipeline("feature-extraction", currentModelId, pipelineOptions) as FeatureExtractionPipeline;
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

// ── Tokenizer & embedding merge for oversized chunks ──

export async function getTokenizer(): Promise<PreTrainedTokenizer> {
  if (!tokenizer) {
    tokenizer = await AutoTokenizer.from_pretrained(currentModelId);
  }
  return tokenizer;
}

function tokenWindows(
  text: string,
  tok: PreTrainedTokenizer,
  windowSize: number,
  overlap: number,
): string[] {
  const ids = Array.from(tok.encode(text));
  if (ids.length <= windowSize) return [text];

  const windows: string[] = [];
  let start = 0;
  while (start < ids.length) {
    const end = Math.min(start + windowSize, ids.length);
    windows.push(tok.decode(ids.slice(start, end), { skip_special_tokens: true }));
    if (end >= ids.length) break;
    start = end - overlap;
  }
  return windows;
}

export function mergeEmbeddings(embeddings: Float32Array[]): Float32Array {
  const dim = embeddings[0].length;
  const avg = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) avg[i] /= norm;
  return avg;
}

/**
 * Embed a batch of texts, merging windowed embeddings for texts that exceed
 * the model's token limit. Short texts pass through normally; oversized texts
 * are split into overlapping 256-token windows, each embedded, then averaged
 * and normalized into a single vector.
 */
export async function embedBatchMerged(
  texts: string[],
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const tok = await getTokenizer();

  // Classify each text and build a flat list of all texts to embed
  const flatTexts: string[] = [];
  const mapping: { type: "short"; flatIdx: number }[] | { type: "oversized"; flatStart: number; flatEnd: number }[] = [];

  for (const text of texts) {
    const tokenCount = Array.from(tok.encode(text)).length;
    if (tokenCount <= MODEL_MAX_TOKENS) {
      (mapping as any[]).push({ type: "short", flatIdx: flatTexts.length });
      flatTexts.push(text);
    } else {
      const windows = tokenWindows(text, tok, MODEL_MAX_TOKENS, MERGE_WINDOW_OVERLAP);
      const start = flatTexts.length;
      flatTexts.push(...windows);
      (mapping as any[]).push({ type: "oversized", flatStart: start, flatEnd: flatTexts.length });
    }
  }

  // Single embedBatch call for all texts + windows
  const allEmbeddings = await embedBatch(flatTexts, threads, onProgress);

  // Reassemble: short texts get their embedding, oversized get merged windows
  const result: Float32Array[] = [];
  for (const entry of mapping as any[]) {
    if (entry.type === "short") {
      result.push(allEmbeddings[entry.flatIdx]);
    } else {
      const windowEmbs = allEmbeddings.slice(entry.flatStart, entry.flatEnd);
      result.push(mergeEmbeddings(windowEmbs));
    }
  }
  return result;
}

/** Reset the singleton — only for testing */
export function resetEmbedder(): void {
  extractor = null;
  tokenizer = null;
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
