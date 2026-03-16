/**
 * Analyze how much of AST-aware chunks the embedding model actually sees.
 *
 * all-MiniLM-L6-v2 has a 256-token max sequence length. Anything beyond
 * that is silently truncated. This script measures:
 *   - How many AST chunks exceed the token limit
 *   - How much content is lost to truncation
 *   - Whether merged embeddings (embed windows, then average) would help
 */
import { resolve, extname } from "path";
import { readFileSync, readdirSync } from "fs";
import { AutoTokenizer, type PreTrainedTokenizer } from "@huggingface/transformers";
import { chunkText, KNOWN_EXTENSIONS } from "../src/indexing/chunker";
import { parseFile } from "../src/indexing/parse";
import { loadConfig, applyEmbeddingConfig } from "../src/config";
import { embed, embedBatch } from "../src/embeddings/embed";

const PROJECT_DIR = resolve(import.meta.dir, "..");
const MODEL_MAX_TOKENS = 256;

const AST_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".cs", ".rb", ".php",
]);

// ── Collect files ──

function getProjectFiles(): { absPath: string; relPath: string }[] {
  const files: { absPath: string; relPath: string }[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = `${dir}/${entry.name}`;
      const rel = abs.slice(PROJECT_DIR.length + 1);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!KNOWN_EXTENSIONS.has(ext)) continue;
      if (rel.startsWith("tests/fixtures/")) continue;
      files.push({ absPath: abs, relPath: rel });
    }
  }
  walk(PROJECT_DIR);
  return files;
}

// ── Cosine similarity ──

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function avgEmbeddings(embeddings: Float32Array[]): Float32Array {
  const dim = embeddings[0].length;
  const avg = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) avg[i] += emb[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += avg[i] * avg[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) avg[i] /= norm;
  return avg;
}

function getTokenIds(text: string, tokenizer: PreTrainedTokenizer): number[] {
  return Array.from(tokenizer.encode(text));
}

// Split text into token windows and decode back to strings
function tokenWindows(
  text: string,
  tokenizer: PreTrainedTokenizer,
  windowSize: number,
  overlap: number,
): string[] {
  const ids = getTokenIds(text, tokenizer);

  if (ids.length <= windowSize) return [text];

  const windows: string[] = [];
  let start = 0;
  while (start < ids.length) {
    const end = Math.min(start + windowSize, ids.length);
    const windowIds = ids.slice(start, end);
    windows.push(tokenizer.decode(windowIds, { skip_special_tokens: true }));
    if (end >= ids.length) break;
    start = end - overlap;
  }
  return windows;
}

function tokenCount(text: string, tokenizer: PreTrainedTokenizer): number {
  return getTokenIds(text, tokenizer).length;
}

// ── Main ──

async function main() {
  console.log("=== AST Chunk Truncation Analysis ===\n");

  const config = await loadConfig(PROJECT_DIR);
  await applyEmbeddingConfig(config);

  console.log("Loading tokenizer...");
  const tokenizer = await AutoTokenizer.from_pretrained("Xenova/all-MiniLM-L6-v2");

  const files = getProjectFiles().filter(f => AST_EXTS.has(extname(f.absPath).toLowerCase()));
  console.log(`Code files: ${files.length}`);

  // ── Phase 1: Measure truncation ──
  console.log("\n── Phase 1: Truncation Analysis ──\n");

  interface TruncatedChunk {
    file: string;
    label: string;
    text: string;
    tokens: number;
    pctLost: number;
  }

  const truncated: TruncatedChunk[] = [];
  let totalASTChunks = 0;

  for (const file of files) {
    const raw = readFileSync(file.absPath, "utf-8");
    const parsed = parseFile(file.absPath, raw);
    const result = await chunkText(parsed.content, parsed.extension, 512, 50, file.absPath);

    for (const chunk of result.chunks) {
      totalASTChunks++;
      const tokens = tokenCount(chunk.text, tokenizer);

      if (tokens > MODEL_MAX_TOKENS) {
        const label = chunk.exports?.[0]?.name ?? chunk.parentName ?? `chunk@L${chunk.startLine ?? "?"}`;
        truncated.push({
          file: file.relPath,
          label,
          text: chunk.text,
          tokens,
          pctLost: ((tokens - MODEL_MAX_TOKENS) / tokens) * 100,
        });
      }
    }
  }

  console.log(`Total AST chunks: ${totalASTChunks}`);
  console.log(`Truncated (>${MODEL_MAX_TOKENS} tokens): ${truncated.length} (${(truncated.length / totalASTChunks * 100).toFixed(1)}%)`);

  if (truncated.length === 0) {
    console.log("No truncated chunks — nothing to test.");
    return;
  }

  const avgLost = truncated.reduce((s, c) => s + c.pctLost, 0) / truncated.length;
  console.log(`Average content lost: ${avgLost.toFixed(1)}%`);

  const sorted = truncated.sort((a, b) => b.tokens - a.tokens);
  console.log(`\nTop 20 most truncated:`);
  console.log(`${"File".padEnd(45)} ${"Entity".padEnd(30)} Tokens  Lost`);
  console.log("-".repeat(100));
  for (const c of sorted.slice(0, 20)) {
    console.log(`${c.file.padEnd(45)} ${c.label.padEnd(30)} ${String(c.tokens).padStart(5)}   ${c.pctLost.toFixed(0)}%`);
  }

  // ── Phase 2: Embedding merge quality on top truncated chunks ──
  console.log("\n── Phase 2: Embedding Merge Quality ──\n");
  console.log("Comparing strategies for the 15 largest truncated chunks:");
  console.log("  A) Truncated (current) — model sees first ~256 tokens");
  console.log("  B) Merged average — 256-token windows with 32-token overlap, averaged");
  console.log("");

  const WINDOW_OVERLAP = 32;
  const testChunks = sorted.slice(0, 15);

  console.log(`${"File:Entity".padEnd(55)} Tokens  Win  Cos(A,B)`);
  console.log("-".repeat(80));

  for (const info of testChunks) {
    // A: current (truncated)
    const embA = await embed(info.text);

    // B: windowed average
    const windows = tokenWindows(info.text, tokenizer, MODEL_MAX_TOKENS, WINDOW_OVERLAP);
    const windowEmbs = await embedBatch(windows);
    const embB = avgEmbeddings(windowEmbs);

    const sim = cosine(embA, embB);
    const label = `${info.file}:${info.label}`;
    console.log(`${label.padEnd(55)} ${String(info.tokens).padStart(5)}   ${String(windows.length).padStart(2)}   ${sim.toFixed(3)}`);
  }

  // ── Phase 3: Tail-content retrieval test ──
  console.log("\n── Phase 3: Tail Content Retrieval ──\n");
  console.log("Can merged embeddings find content PAST the truncation point?");
  console.log("Query = phrase extracted from tokens 256-286 (invisible to truncated embedding)\n");

  console.log(`${"Entity".padEnd(40)} Sim(A)  Sim(B)  Delta   Query snippet`);
  console.log("-".repeat(110));

  for (const info of sorted.slice(0, 15)) {
    const ids = getTokenIds(info.text, tokenizer);

    if (ids.length <= MODEL_MAX_TOKENS + 30) continue;

    // Extract a phrase from right after the truncation cutoff
    const tailIds = ids.slice(MODEL_MAX_TOKENS, MODEL_MAX_TOKENS + 30);
    const tailSnippet = tokenizer.decode(tailIds, { skip_special_tokens: true }).trim();
    if (!tailSnippet || tailSnippet.length < 10) continue;

    const queryEmb = await embed(tailSnippet);

    // A: truncated
    const embA = await embed(info.text);
    const simA = cosine(queryEmb, embA);

    // B: merged windows
    const windows = tokenWindows(info.text, tokenizer, MODEL_MAX_TOKENS, WINDOW_OVERLAP);
    const windowEmbs = await embedBatch(windows);
    const embB = avgEmbeddings(windowEmbs);
    const simB = cosine(queryEmb, embB);

    const delta = simB - simA;
    const snippet = tailSnippet.slice(0, 40).replace(/\n/g, " ");
    console.log(
      `${info.label.padEnd(40)} ${simA.toFixed(3)}   ${simB.toFixed(3)}   ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}   "${snippet}..."`
    );
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
