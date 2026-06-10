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

// Escape hatch for machines behind a TLS-intercepting proxy whose root CA can't
// be added to NODE_EXTRA_CA_CERTS. Disables certificate verification *only* for
// the model-download window (pipeline + tokenizer fetch), then restores it.
// Transport trust is dropped, but content integrity still holds: the pinned
// default model is sha256-verified after download (verifyDefaultModelChecksum),
// so a tampered or proxy-mangled file is still rejected. Prefer NODE_EXTRA_CA_CERTS.
const INSECURE_TLS = process.env.MIMIRS_INSECURE_TLS === "1";
let warnedInsecure = false;

// Run an async download with TLS verification disabled, scoped to this call.
// NODE_TLS_REJECT_UNAUTHORIZED is read per-connection, so saving/restoring it
// around the await covers the fetch window. Concurrent TLS in the same window
// would also be affected — model loads run at startup, so this is acceptable.
async function withInsecureTLS<T>(fn: () => Promise<T>): Promise<T> {
  if (!INSECURE_TLS) return fn();
  if (!warnedInsecure) {
    warnedInsecure = true;
    const integrity = isPinnedDefaultModel()
      ? "Integrity still enforced by the pinned sha256 checksum."
      : "NO integrity verification for this model (only the pinned default has a known checksum).";
    console.warn(
      `[mimirs] MIMIRS_INSECURE_TLS=1 — TLS verification DISABLED for model download. ` +
        `${integrity} Prefer NODE_EXTRA_CA_CERTS.`,
    );
  }
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
}

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
// sha256 of tokenizer.json at that revision, verified against HF upstream.
// The tokenizer shapes every embedding (and windowing decisions), so it needs
// the same integrity guarantee as the weights under MIMIRS_INSECURE_TLS.
export const DEFAULT_TOKENIZER_SHA256 = "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0";

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
  // DELIBERATELY conservative — do not raise this default. The project
  // originally shipped cores/2 and users complained that indexing made their
  // machines unusable; mimirs indexes in the background while people work.
  // Raw throughput says more threads win (measured, 10-core M-series, 200
  // real chunks: 2t=19.4ms/chunk · 4t=11.5 · 6t=9.4 · 8t=9.0 · 12t=10.5,
  // embedding is ~95% of index time), but day-to-day machine impact beats
  // index speed for a default. Users who want a faster foreground index set
  // config.indexThreads explicitly.
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

// transformers.js keys its cache by revision when the revision isn't "main"
// (hub.js: pathJoin(repo_id, revision, filename)), so the pinned default lives
// under <cache>/<repo>/<revision>/. Hashing any other path verifies a file the
// loader never reads.
function defaultModelDir(): string {
  return join(CACHE_DIR, ...DEFAULT_MODEL_ID.split("/"), DEFAULT_MODEL_REVISION);
}

function defaultModelOnnxPath(): string {
  return join(defaultModelDir(), "onnx", "model_quantized.onnx");
}

function defaultTokenizerPath(): string {
  return join(defaultModelDir(), "tokenizer.json");
}

// Only the pinned default (model + q8 dtype + pinned revision) has a known hash.
function isPinnedDefaultModel(): boolean {
  return (
    currentModelId === DEFAULT_MODEL_ID &&
    currentDtype === "q8" &&
    currentRevision === DEFAULT_MODEL_REVISION
  );
}

// sha256 of the cached default-model weights, or null if not yet downloaded.
function cachedDefaultModelHash(): string | null {
  const file = defaultModelOnnxPath();
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Delete a corrupt cached default model BEFORE handing it to ORT, so a
// proxy-mangled or truncated download fails as a clear checksum miss instead of
// a cryptic "Protobuf parsing failed" — which otherwise drops into the retry
// branch and, behind a cert-blocked proxy, re-downloads the same junk in a loop.
// Returns true if it removed a bad cache (caller should expect a re-download).
function purgeCorruptDefaultModel(): boolean {
  const actual = cachedDefaultModelHash();
  if (actual === null || actual === DEFAULT_MODEL_SHA256) return false;
  rmSync(join(CACHE_DIR, ...DEFAULT_MODEL_ID.split("/")), { recursive: true, force: true });
  console.warn(
    `[mimirs] Cached embedding model failed checksum (expected ${DEFAULT_MODEL_SHA256}, ` +
      `got ${actual}) — deleted, will re-download.`,
  );
  return true;
}

// Reject a tampered/swapped model file that still parses. Pinning the revision
// makes the download immutable on HF's side; this catches a compromised mirror,
// MITM, or corrupted transfer. On mismatch, delete the cache and refuse to load.
// Fails CLOSED: this runs only after pipeline() successfully loaded the pinned
// default, so the file must exist at the revision-keyed path — absence means
// the cache-layout assumption broke and we'd otherwise be verifying nothing.
function verifyDefaultModelChecksum(): void {
  const actual = cachedDefaultModelHash();
  if (actual === null) {
    throw new Error(
      `Embedding model loaded but ${defaultModelOnnxPath()} is missing — ` +
        `cache layout changed and the checksum can't be verified. Refusing to proceed unverified.`,
    );
  }
  if (actual !== DEFAULT_MODEL_SHA256) {
    rmSync(join(CACHE_DIR, ...DEFAULT_MODEL_ID.split("/")), { recursive: true, force: true });
    throw new Error(
      `Embedding model checksum mismatch for ${DEFAULT_MODEL_ID}@${DEFAULT_MODEL_REVISION}: ` +
        `expected ${DEFAULT_MODEL_SHA256}, got ${actual}. ` +
        `Deleted the cached copy; refusing to load a possibly-tampered model.`,
    );
  }
}

// Same contract for tokenizer.json: it shapes every embedding, so it gets the
// same pin + verify treatment as the weights. Only the pinned default has a
// known hash; custom models skip this (and the insecure-TLS warning says so).
function verifyDefaultTokenizerChecksum(): void {
  const file = defaultTokenizerPath();
  if (!existsSync(file)) {
    throw new Error(
      `Tokenizer loaded but ${file} is missing — cache layout changed and the ` +
        `checksum can't be verified. Refusing to proceed unverified.`,
    );
  }
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== DEFAULT_TOKENIZER_SHA256) {
    rmSync(join(CACHE_DIR, ...DEFAULT_MODEL_ID.split("/")), { recursive: true, force: true });
    throw new Error(
      `Tokenizer checksum mismatch for ${DEFAULT_MODEL_ID}@${DEFAULT_MODEL_REVISION}: ` +
        `expected ${DEFAULT_TOKENIZER_SHA256}, got ${actual}. ` +
        `Deleted the cached copy; refusing to use a possibly-tampered tokenizer.`,
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
    // Catch a corrupt cached default model before ORT chokes on it: hash-check
    // and purge up front so we re-download cleanly instead of crashing on parse.
    if (isPinnedDefaultModel()) purgeCorruptDefaultModel();
    onProgress?.(`Loading embedding model ${currentModelId}...`);
    try {
      // @ts-expect-error — pipeline() overload union is too complex for tsc
      extractor = await withInsecureTLS(() => pipeline("feature-extraction", currentModelId, pipelineOptions));
    } catch (err) {
      // If the cached model is corrupted, delete it and retry once
      const msg = (err as Error).message || "";
      if (msg.includes("Protobuf parsing failed") || msg.includes("Load model")) {
        const modelDir = join(CACHE_DIR, ...currentModelId.split("/"));
        rmSync(modelDir, { recursive: true, force: true });
        onProgress?.(`Retrying model load (cache was corrupted)...`);
        extractor = await withInsecureTLS(() => pipeline("feature-extraction", currentModelId, pipelineOptions)) as FeatureExtractionPipeline;
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
  // Slice by the model's actual output dim, not the configured one: if they
  // disagree, slicing by currentDim shifts every vector after the first into
  // misaligned garbage with no error. Fail loudly instead.
  const actualDim = output.dims?.at(-1);
  if (typeof actualDim === "number" && actualDim !== currentDim) {
    throw new Error(
      `Embedding dim mismatch: model ${currentModelId} outputs ${actualDim}, ` +
        `but embeddingDim is configured as ${currentDim}. Fix embeddingDim in config.`,
    );
  }
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
    // Same revision as the model: an unpinned tokenizer rides mutable `main`,
    // which can diverge from what pipeline() loaded at the pinned revision —
    // windowing decisions would then disagree with the model's own tokenizer.
    const loaded = await withInsecureTLS(() =>
      AutoTokenizer.from_pretrained(currentModelId, { revision: currentRevision }),
    );
    if (isPinnedDefaultModel()) {
      verifyDefaultTokenizerChecksum(); // throws on mismatch; don't cache a rejected tokenizer
    }
    tokenizer = loaded;
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
