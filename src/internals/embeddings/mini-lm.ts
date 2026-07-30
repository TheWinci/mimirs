import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { join } from "node:path";

import {
  AutoTokenizer,
  env,
  pipeline,
  type FeatureExtractionPipeline,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

import type {
  Embedder,
  EmbedOptions,
} from "./embedder.ts";

export const MINI_LM_MODEL = "Xenova/all-MiniLM-L6-v2";
export const MINI_LM_REVISION =
  "751bff37182d3f1213fa05d7196b954e230abad9";
export const MINI_LM_VARIANT =
  "mean|q8|normalized|token-window:256:32|average-merge:v1|" +
  "token-length-bucket:v1|transformers:3.8.1";
export const MINI_LM_DIMENSIONS = 384;
export const MINI_LM_MODEL_SHA256 =
  "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1";
export const MINI_LM_TOKENIZER_SHA256 =
  "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0";

const MODEL_MAX_TOKENS = 256;
const TOKEN_WINDOW_OVERLAP = 32;
const MODEL_INFERENCE_BATCH_SIZE = 32;
const CACHE_DIRECTORY = join(homedir(), ".cache", "mimirs", "models");

env.cacheDir = CACHE_DIRECTORY;

let extractor: FeatureExtractionPipeline | null = null;
let tokenizer: PreTrainedTokenizer | null = null;
let warnedInsecureTls = false;

function modelDirectory(): string {
  return join(CACHE_DIRECTORY, ...MINI_LM_MODEL.split("/"), MINI_LM_REVISION);
}

function modelPath(): string {
  return join(modelDirectory(), "onnx", "model_quantized.onnx");
}

function tokenizerPath(): string {
  return join(modelDirectory(), "tokenizer.json");
}

function fileHash(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function removeCachedModel(): void {
  rmSync(join(CACHE_DIRECTORY, ...MINI_LM_MODEL.split("/")), {
    recursive: true,
    force: true,
  });
}

function purgeCorruptCachedModel(): void {
  const actual = fileHash(modelPath());
  if (actual === null || actual === MINI_LM_MODEL_SHA256) return;
  removeCachedModel();
  console.warn(
    `[mimirs] Cached embedding model failed checksum; deleted ${MINI_LM_MODEL}.`,
  );
}

function verifyFile(path: string, expected: string, label: string): void {
  const actual = fileHash(path);
  if (actual === expected) return;
  removeCachedModel();
  throw new Error(
    `${label} checksum mismatch for ${MINI_LM_MODEL}@${MINI_LM_REVISION}: ` +
      `expected ${expected}, got ${actual ?? "missing"}; deleted the cached copy`,
  );
}

async function withModelDownloadTls<T>(operation: () => Promise<T>): Promise<T> {
  if (process.env.MIMIRS_INSECURE_TLS !== "1") return operation();
  if (!warnedInsecureTls) {
    warnedInsecureTls = true;
    console.warn(
      "[mimirs] MIMIRS_INSECURE_TLS=1 disables TLS verification during the " +
        "model download; pinned checksums remain enforced.",
    );
  }
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
}

function threadCount(): number | undefined {
  const configured = process.env.MIMIRS_EMBEDDING_THREADS;
  if (configured === "auto") return undefined;
  if (configured === undefined) return Math.max(1, Math.floor(cpus().length / 3));
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(
      "MIMIRS_EMBEDDING_THREADS must be a positive integer",
    );
  }
  return parsed;
}

export async function getMiniLmPipeline(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  purgeCorruptCachedModel();
  const threads = threadCount();
  const options = {
    dtype: "q8" as const,
    revision: MINI_LM_REVISION,
    ...(threads === undefined ? {} : {
      session_options: { intraOpNumThreads: threads },
    }),
  };
  const loadPipeline = pipeline as unknown as (
    task: "feature-extraction",
    model: string,
    pipelineOptions: typeof options,
  ) => Promise<FeatureExtractionPipeline>;
  try {
    extractor = await withModelDownloadTls(() =>
      loadPipeline("feature-extraction", MINI_LM_MODEL, options)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Protobuf parsing failed") &&
      !message.includes("Load model")) {
      throw error;
    }
    removeCachedModel();
    extractor = await withModelDownloadTls(() =>
      loadPipeline("feature-extraction", MINI_LM_MODEL, options)
    );
  }
  try {
    verifyFile(modelPath(), MINI_LM_MODEL_SHA256, "Embedding model");
  } catch (error) {
    extractor = null;
    tokenizer = null;
    throw error;
  }
  return extractor;
}

export async function getMiniLmTokenizer(): Promise<PreTrainedTokenizer> {
  if (tokenizer) return tokenizer;
  const loaded = await withModelDownloadTls(() =>
    AutoTokenizer.from_pretrained(MINI_LM_MODEL, {
      revision: MINI_LM_REVISION,
    })
  );
  try {
    verifyFile(tokenizerPath(), MINI_LM_TOKENIZER_SHA256, "Tokenizer");
  } catch (error) {
    tokenizer = null;
    extractor = null;
    throw error;
  }
  tokenizer = loaded;
  return tokenizer;
}

function tokenWindows(
  text: string,
  loadedTokenizer: PreTrainedTokenizer,
): Array<{ text: string; tokenCount: number }> {
  const ids = Array.from(loadedTokenizer.encode(text));
  if (ids.length <= MODEL_MAX_TOKENS) {
    return [{ text, tokenCount: ids.length }];
  }
  const windows: Array<{ text: string; tokenCount: number }> = [];
  let start = 0;
  while (start < ids.length) {
    const end = Math.min(start + MODEL_MAX_TOKENS, ids.length);
    windows.push({
      text: loadedTokenizer.decode(ids.slice(start, end), {
        skip_special_tokens: true,
      }),
      tokenCount: end - start,
    });
    if (end === ids.length) break;
    start = end - TOKEN_WINDOW_OVERLAP;
  }
  return windows;
}

interface TokenPiece {
  start: number;
  end: number;
  tokens: number;
}

function tokenizerPieces(
  text: string,
  loadedTokenizer: PreTrainedTokenizer,
): TokenPiece[] {
  const internal = loadedTokenizer as PreTrainedTokenizer & {
    pre_tokenizer: { pattern: RegExp };
    normalizer?: (value: string) => string;
    model: (values: readonly string[]) => readonly unknown[];
  };
  const basePattern = internal.pre_tokenizer.pattern;
  const flags = basePattern.flags.includes("g")
    ? basePattern.flags
    : `${basePattern.flags}g`;
  const pattern = new RegExp(basePattern.source, flags);
  const pieces: TokenPiece[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    const raw = match[0]!;
    const normalized = internal.normalizer
      ? internal.normalizer(raw)
      : raw;
    pieces.push({
      start,
      end: start + raw.length,
      tokens: Math.max(1, internal.model([normalized]).length),
    });
  }
  return pieces;
}

function pathAverageWindows(
  projected: string,
  loadedTokenizer: PreTrainedTokenizer,
): string[] {
  const newline = projected.indexOf("\n");
  if (!projected.startsWith("File: ") || newline <= "File: ".length) {
    throw new Error(
      "path-average MiniLM input must start with `File: <relative path>\\n`",
    );
  }
  const prefix = projected.slice(0, newline + 1);
  const text = projected.slice(newline + 1);
  if (Array.from(loadedTokenizer.encode(projected)).length <= MODEL_MAX_TOKENS) {
    return [projected];
  }
  const pieces = tokenizerPieces(text, loadedTokenizer);
  if (pieces.length === 0) {
    throw new Error("path-average MiniLM could not split an oversized input");
  }
  const windows: string[] = [];
  let startPiece = 0;
  while (startPiece < pieces.length) {
    let endPiece = startPiece;
    let tokens = Array.from(loadedTokenizer.encode(prefix)).length;
    while (
      endPiece < pieces.length &&
      tokens + pieces[endPiece]!.tokens <= MODEL_MAX_TOKENS
    ) {
      tokens += pieces[endPiece]!.tokens;
      endPiece++;
    }
    if (endPiece === startPiece) endPiece++;
    const start = startPiece === 0 ? 0 : pieces[startPiece]!.start;
    let end = endPiece === pieces.length
      ? text.length
      : pieces[endPiece]!.start;
    while (
      endPiece > startPiece + 1 &&
      Array.from(loadedTokenizer.encode(prefix + text.slice(start, end))).length >
        MODEL_MAX_TOKENS
    ) {
      endPiece--;
      end = pieces[endPiece]!.start;
    }
    const window = prefix + text.slice(start, end);
    if (Array.from(loadedTokenizer.encode(window)).length > MODEL_MAX_TOKENS) {
      throw new Error(
        "path-average MiniLM could not fit a source piece within 256 tokens",
      );
    }
    windows.push(window);
    if (endPiece === pieces.length) break;
    let next = endPiece;
    let overlap = 0;
    while (next > startPiece && overlap < TOKEN_WINDOW_OVERLAP) {
      next--;
      overlap += pieces[next]!.tokens;
    }
    startPiece = next > startPiece ? next : endPiece;
  }
  return windows;
}

function mergeVectors(vectors: readonly Float32Array[]): Float32Array {
  if (vectors.length === 0) throw new Error("cannot merge zero embeddings");
  const merged = new Float32Array(MINI_LM_DIMENSIONS);
  for (const vector of vectors) {
    for (let index = 0; index < merged.length; index++) {
      merged[index]! += vector[index]!;
    }
  }
  let norm = 0;
  for (let index = 0; index < merged.length; index++) {
    merged[index]! /= vectors.length;
    norm += merged[index]! * merged[index]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < merged.length; index++) {
      merged[index]! /= norm;
    }
  }
  return merged;
}

async function embedFlat(texts: readonly string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const model = await getMiniLmPipeline();
  const output = await model([...texts], { pooling: "mean", normalize: true });
  const actualDimensions = output.dims?.at(-1);
  if (actualDimensions !== MINI_LM_DIMENSIONS) {
    throw new Error(
      `Embedding dimension mismatch: ${MINI_LM_MODEL} returned ` +
        `${String(actualDimensions)}, expected ${MINI_LM_DIMENSIONS}`,
    );
  }
  const flat = new Float32Array(output.data as Float32Array);
  if (flat.length !== texts.length * MINI_LM_DIMENSIONS) {
    throw new Error(
      `Embedding output length mismatch: received ${flat.length} values for ` +
        `${texts.length} texts`,
    );
  }
  const vectors: Float32Array[] = [];
  for (let index = 0; index < texts.length; index++) {
    vectors.push(flat.slice(
      index * MINI_LM_DIMENSIONS,
      (index + 1) * MINI_LM_DIMENSIONS,
    ));
  }
  return vectors;
}

export async function embedWithMiniLm(
  texts: readonly string[],
  options: { bucketByTokenLength?: boolean } = {},
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const loadedTokenizer = await getMiniLmTokenizer();
  const flatWindows: Array<{ text: string; tokenCount: number }> = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const text of texts) {
    const windows = tokenWindows(text, loadedTokenizer);
    const start = flatWindows.length;
    flatWindows.push(...windows);
    ranges.push({ start, end: flatWindows.length });
  }
  const order = flatWindows.map((_, index) => index);
  if (options.bucketByTokenLength !== false) {
    order.sort((left, right) =>
      flatWindows[left]!.tokenCount - flatWindows[right]!.tokenCount ||
      left - right
    );
  }
  const orderedVectors: Float32Array[] = [];
  for (let start = 0; start < order.length; start += MODEL_INFERENCE_BATCH_SIZE) {
    orderedVectors.push(...await embedFlat(
      order.slice(start, start + MODEL_INFERENCE_BATCH_SIZE).map((index) =>
        flatWindows[index]!.text
      ),
    ));
  }
  const flatVectors = new Array<Float32Array>(orderedVectors.length);
  for (let index = 0; index < order.length; index++) {
    flatVectors[order[index]!] = orderedVectors[index]!;
  }
  return ranges.map(({ start, end }) =>
    end - start === 1
      ? flatVectors[start]!
      : mergeVectors(flatVectors.slice(start, end))
  );
}

/**
 * Embed path-prefixed document inputs independently and average their exact
 * source-token windows. Query inference continues to use `embedWithMiniLm`.
 */
export async function embedPathAveragedWithMiniLm(
  projectedTexts: readonly string[],
  options: EmbedOptions = {},
): Promise<Float32Array[]> {
  if (projectedTexts.length === 0) return [];
  const plans = await preparePathAverageMiniLmInputs(projectedTexts);
  const uniqueInputs: string[] = [];
  const inputIndex = new Map<string, number>();
  const planIndexes = plans.map((windows) => windows.map((window) => {
    const existing = inputIndex.get(window);
    if (existing !== undefined) return existing;
    const index = uniqueInputs.length;
    uniqueInputs.push(window);
    inputIndex.set(window, index);
    return index;
  }));
  const uniqueVectors: Float32Array[] = [];
  for (let index = 0; index < uniqueInputs.length; index++) {
    const input = uniqueInputs[index]!;
    uniqueVectors.push((await embedFlat([input]))[0]!);
    await options.onProgress?.({
      completed: index + 1,
      total: uniqueInputs.length,
    });
  }
  return planIndexes.map((indexes) =>
    indexes.length === 1
      ? uniqueVectors[indexes[0]!]!
      : mergeVectors(indexes.map((index) => uniqueVectors[index]!))
  );
}

/** Expose deterministic final document inputs for correctness tests/profiling. */
export async function preparePathAverageMiniLmInputs(
  projectedTexts: readonly string[],
): Promise<string[][]> {
  if (projectedTexts.length === 0) return [];
  const loadedTokenizer = await getMiniLmTokenizer();
  return projectedTexts.map((text) =>
    pathAverageWindows(text, loadedTokenizer)
  );
}

export const miniLmEmbedder: Embedder = Object.freeze({
  model: MINI_LM_MODEL,
  revision: MINI_LM_REVISION,
  variant: MINI_LM_VARIANT,
  dimensions: MINI_LM_DIMENSIONS,
  embed: (texts: readonly string[]) => embedWithMiniLm(texts),
});

/** Clear process-local model singletons; intended for isolated tests only. */
export function resetMiniLmEmbedder(): void {
  extractor = null;
  tokenizer = null;
}
