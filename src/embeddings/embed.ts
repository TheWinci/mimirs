import {
  env,
  pipeline,
  AutoTokenizer,
  type FeatureExtractionPipeline,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { join } from "node:path";
import { homedir, cpus } from "node:os";
import { rmSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { timed } from "../utils/profiler";

// Use a stable cache directory so models survive bunx temp dir cleanup
const CACHE_DIR = join(homedir(), ".cache", "mimirs", "models");
env.cacheDir = CACHE_DIR;

const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIM = 384;
// Pin the default model to an immutable commit. Without this, transformers.js
// fetches from the mutable `main` ref, so whatever HF serves at download time is
// what we load. Bump deliberately (and re-pin DEFAULT_MODEL_SHA256 below) when
// moving versions. "main" is the un-pinned fallback for opted-in custom models.
// SHA from https://huggingface.co/Xenova/all-MiniLM-L6-v2/commits/main
export const DEFAULT_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
// sha256 of the q8 ONNX weights (onnx/model_quantized.onnx) at that revision —
// verified against HF's upstream LFS oid. Verified after download so a tampered
// or swapped file is rejected even if it still parses. Re-pin when the revision
// or default dtype changes (the q4/fp16/etc. variants have different hashes).
export const DEFAULT_MODEL_SHA256 = "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1";

// Pooling and quantization are model-dependent: sentence-transformers models
// (all-MiniLM) want mean pooling; BGE/GTE/ModernBERT/Arctic want CLS. Configurable
// so a different embedding model can be pooled correctly.
export type EmbeddingPooling = "mean" | "cls" | "none";
export const DEFAULT_POOLING: EmbeddingPooling = "mean";
export const DEFAULT_DTYPE = "q8";

const MODEL_MAX_TOKENS = 256;
const MERGE_WINDOW_OVERLAP = 32;

let currentModelId = DEFAULT_MODEL_ID;
let currentDim = DEFAULT_EMBEDDING_DIM;
let currentPooling: EmbeddingPooling = DEFAULT_POOLING;
let currentDtype: string = DEFAULT_DTYPE;
let currentRevision: string = DEFAULT_MODEL_REVISION;
let extractor: FeatureExtractionPipeline | null = null;
let tokenizer: PreTrainedTokenizer | null = null;

function defaultThreadCount(): number {
  return Math.max(2, Math.floor(cpus().length / 3));
}

/**
 * Configure a different embedding model. Must be called before getEmbedder().
 * Resets the singleton if the model changes.
 */
export function configureEmbedder(
  modelId: string,
  dim: number,
  pooling: EmbeddingPooling = DEFAULT_POOLING,
  dtype: string = DEFAULT_DTYPE,
  revision?: string,
): void {
  // Pin the default model; any other model rides `main` unless a revision is given.
  const effRevision = revision ?? (modelId === DEFAULT_MODEL_ID ? DEFAULT_MODEL_REVISION : "main");
  if (
    modelId !== currentModelId ||
    dim !== currentDim ||
    pooling !== currentPooling ||
    dtype !== currentDtype ||
    effRevision !== currentRevision
  ) {
    extractor = null;
    tokenizer = null;
    currentModelId = modelId;
    currentDim = dim;
    currentPooling = pooling;
    currentDtype = dtype;
    currentRevision = effRevision;
  }
}

// transformers.js downloads the q8 weights to this file for the default model.
function defaultModelOnnxPath(): string {
  return join(CACHE_DIR, "Xenova", "all-MiniLM-L6-v2", "onnx", "model_quantized.onnx");
}

// Only the pinned default (model + q8 dtype + pinned revision) has a known hash.
function isPinnedDefaultModel(): boolean {
  return (
    currentModelId === DEFAULT_MODEL_ID &&
    currentDtype === "q8" &&
    currentRevision === DEFAULT_MODEL_REVISION
  );
}

// Reject a tampered/swapped model file that still parses. Pinning the revision
// makes the download immutable on HF's side; this catches a compromised mirror,
// MITM, or corrupted transfer. On mismatch, delete the cache and refuse to load.
function verifyDefaultModelChecksum(): void {
  const file = defaultModelOnnxPath();
  if (!existsSync(file)) return; // pipeline() would have thrown already; nothing to check
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== DEFAULT_MODEL_SHA256) {
    rmSync(join(CACHE_DIR, "Xenova", "all-MiniLM-L6-v2"), { recursive: true, force: true });
    throw new Error(
      `Embedding model checksum mismatch for ${DEFAULT_MODEL_ID}@${DEFAULT_MODEL_REVISION}: ` +
        `expected ${DEFAULT_MODEL_SHA256}, got ${actual}. ` +
        `Deleted the cached copy; refusing to load a possibly-tampered model.`,
    );
  }
}

export async function getEmbedder(
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    const numThreads = threads ?? defaultThreadCount();
    const pipelineOptions = {
      dtype: currentDtype as "q8",
      revision: currentRevision,
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
    // Verify integrity once per process (the extractor singleton guards re-entry).
    if (isPinnedDefaultModel()) {
      try {
        verifyDefaultModelChecksum();
      } catch (err) {
        // Don't leave the rejected model loaded for the next caller.
        extractor = null;
        tokenizer = null;
        throw err;
      }
    }
  }
  return extractor;
}

export async function embed(
  text: string,
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<Float32Array> {
  const model = await getEmbedder(threads, onProgress);
  const output = await model(text, { pooling: currentPooling, normalize: true });
  return new Float32Array(output.data as Float64Array);
}

export async function embedBatch(
  texts: string[],
  threads?: number,
  onProgress?: (msg: string) => void,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const model = await getEmbedder(threads, onProgress);
  const output = await timed("embed-inference", () =>
    model(texts, { pooling: currentPooling, normalize: true })
  );
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

  timed("classify", () => {
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
  });

  // Single embedBatch call for all texts + windows
  const allEmbeddings = await embedBatch(flatTexts, threads, onProgress);

  // Reassemble: short texts get their embedding, oversized get merged windows
  return timed("merge", () => {
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
  });
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

/**
 * Current pooling + dtype as a single identity string. Two indexes can share a
 * model id and dim yet differ here (mean vs cls pooling, q8 vs fp32), which
 * still produces an incompatible vector space — recorded so reopen can verify.
 */
export function getEmbeddingVariant(): string {
  return `${currentPooling}|${currentDtype}`;
}

// Backwards-compatible constant export (default dimension)
const EMBEDDING_DIM = DEFAULT_EMBEDDING_DIM;
export { EMBEDDING_DIM, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM };
