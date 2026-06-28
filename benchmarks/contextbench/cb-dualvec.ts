/**
 * Dual-vector probe: does a SEPARATE context embedding beat stuffing context into
 * the chunk vector? Single-vector shape D (locator+blurb in one string) measured
 * WORSE than blurb alone — a 384-dim vector saturates. This tests the alternative:
 * give each chunk a second vector for its context (locator and/or LLM blurb), keep
 * the body vector pure, and fuse by max() at query time (standard multi-representation
 * retrieval). No dilution, because the vectors are separate.
 *
 * Dense-only, offline, doc-level recall@k over the Anthropic bench corpus. Absolute
 * numbers differ from the hybrid headline (no lexical/graph/boosts here) — what
 * matters is body-only vs body+context, measured in the same space.
 *
 * Run: bun benchmarks/contextbench/cb-dualvec.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { RagDB } from "../../src/db";
import { embedBatch, embedBatchMerged } from "../../src/embeddings/embed";

const CORPUS = resolve(import.meta.dir, "../../.cb-anthropic/corpus");
const DATA = resolve(import.meta.dir, "../../.cb-anthropic");
const KS = [1, 3, 5, 10, 20];

interface GoldMeta { uuid: string; meta: { relative_path: string; repo_name: string } }
interface EvalRow { query: string; golden_doc_uuids: string[]; golden_documents: GoldMeta[] }

const cos = (a: Float32Array, b: Float32Array) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
};

async function main() {
  const rows = readFileSync(`${DATA}/evaluation_set.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as EvalRow);
  const blurbs = JSON.parse(readFileSync(`${DATA}/preambles_done.json`, "utf8")) as Record<string, string>;
  const blurbsStruct = JSON.parse(readFileSync(`${DATA}/preambles_done_struct.json`, "utf8")) as Record<string, string>;
  // uuid -> corpus-relative file path (matches how the corpus was materialized)
  const uuidByFile = new Map<string, string>();
  for (const r of rows) for (const gd of r.golden_documents)
    uuidByFile.set(`${gd.meta.repo_name}/${gd.meta.relative_path.replace(/^\/+/, "")}`, gd.uuid);

  const db = new RagDB(CORPUS);
  const prefix = `${CORPUS.replace(/\/$/, "")}/`;
  const chunks = (db as unknown as { db: { query(s: string): { all(): unknown[] } } }).db.query(
    `SELECT c.snippet AS snippet, c.entity_name AS entity, c.chunk_type AS type, c.content_hash AS hash, f.path AS path
     FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.chunk_index >= 0`
  ).all() as { snippet: string; entity: string | null; type: string | null; hash: string | null; path: string }[];
  db.close();

  const docOf = chunks.map((c) => uuidByFile.get(c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path) ?? "?");
  const locText = chunks.map((c) => {
    const rel = c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path;
    const tail = c.entity ? (c.type ? `${c.entity} (${c.type})` : c.entity) : "";
    return [rel, tail].filter(Boolean).join(" › ");
  });
  const blurbText = chunks.map((c) => (c.hash && blurbs[c.hash]) || "");
  const blurbStructText = chunks.map((c) => (c.hash && blurbsStruct[c.hash]) || "");

  console.log(`embedding ${chunks.length} bodies / locators / blurbs + ${rows.length} queries ...`);
  const bodyVec = await embedBatchMerged(chunks.map((c) => c.snippet), undefined, () => {});
  const locVec = await embedBatch(locText, undefined, () => {});
  const blurbVec = await embedBatch(blurbText.map((b) => b || "x"), undefined, () => {});
  const blurbStructVec = await embedBatch(blurbStructText.map((b) => b || "x"), undefined, () => {});
  // QUERY_FILE: array of rewritten queries (row order) — override the query text but
  // keep the same gold, to test how phrasing (human-question vs agent-intent) moves the result.
  const qOverride: (string | null)[] | null = process.env.QUERY_FILE ? JSON.parse(readFileSync(process.env.QUERY_FILE, "utf8")) : null;
  const qVec = await embedBatch(rows.map((r, i) => (qOverride?.[i]) || r.query), undefined, () => {});
  if (qOverride) console.log(`(using rewritten queries from ${process.env.QUERY_FILE})`);

  // For each query rank the 90 docs by max fused chunk score; report doc recall@k.
  function evalArm(label: string, fuse: (qi: number, ci: number) => number) {
    const hit: Record<number, number> = Object.fromEntries(KS.map((k) => [k, 0]));
    let mrr = 0;
    for (let qi = 0; qi < rows.length; qi++) {
      const gold = rows[qi].golden_doc_uuids[0];
      const docScore = new Map<string, number>();
      for (let ci = 0; ci < chunks.length; ci++) {
        const s = fuse(qi, ci);
        const d = docOf[ci];
        if (s > (docScore.get(d) ?? -1)) docScore.set(d, s);
      }
      const ranked = [...docScore.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
      const rank = ranked.indexOf(gold) + 1;
      if (rank > 0) { mrr += 1 / rank; for (const k of KS) if (rank <= k) hit[k]++; }
    }
    const n = rows.length;
    const cells = KS.map((k) => `${(hit[k] / n * 100).toFixed(1)}%`.padStart(7)).join(" ");
    console.log(`${label.padEnd(22)} ${cells}   MRR=${(mrr / n).toFixed(3)}  P@1=${(hit[1] / n * 100).toFixed(1)}%`);
  }

  console.log(`\narm                       ` + KS.map((k) => `R@${k}`.padStart(7)).join(" "));
  evalArm("BODY only", (q, c) => cos(qVec[q], bodyVec[c]));
  evalArm("LOC vec only", (q, c) => cos(qVec[q], locVec[c]));
  evalArm("BLURB-raw vec only", (q, c) => (blurbText[c] ? cos(qVec[q], blurbVec[c]) : -1));
  evalArm("BLURB-struct vec only", (q, c) => (blurbStructText[c] ? cos(qVec[q], blurbStructVec[c]) : -1));
  evalArm("BODY + LOC (max)", (q, c) => Math.max(cos(qVec[q], bodyVec[c]), cos(qVec[q], locVec[c])));
  evalArm("BODY + BLURB-raw (max)", (q, c) => Math.max(cos(qVec[q], bodyVec[c]), blurbText[c] ? cos(qVec[q], blurbVec[c]) : -1));
  evalArm("BODY + BLURB-struct (max)", (q, c) => Math.max(cos(qVec[q], bodyVec[c]), blurbStructText[c] ? cos(qVec[q], blurbStructVec[c]) : -1));

  // ── Fusion sweep: HOW to combine body + context, not just max ────────────────
  // The wall is ranking (recall@100≈100%). max() is recall-flavored (either vector
  // is enough); consensus fusions (product/min/z-sum/RRF) reward agreement — a
  // ranking signal. ctx defaults to BLURB-raw; CTX=loc to sweep the locator pair.
  const useLoc = process.env.CTX === "loc";
  const ctxVec = useLoc ? locVec : blurbVec;
  const ctxHas = useLoc ? locText.map(Boolean) : blurbText.map(Boolean);
  const clamp = (x: number) => Math.max(0, x);

  function sweep(label: string, combine: (b: number, x: number, rb: number, rx: number, zb: number, zx: number) => number) {
    const hit: Record<number, number> = Object.fromEntries(KS.map((k) => [k, 0]));
    let mrr = 0;
    for (let qi = 0; qi < rows.length; qi++) {
      const gold = rows[qi].golden_doc_uuids[0];
      const b = new Float64Array(chunks.length), x = new Float64Array(chunks.length);
      for (let ci = 0; ci < chunks.length; ci++) {
        b[ci] = cos(qVec[qi], bodyVec[ci]);
        x[ci] = ctxHas[ci] ? cos(qVec[qi], ctxVec[ci]) : b[ci]; // missing ctx → neutral (body)
      }
      // per-query ranks (1=best) and z-scores for each layer
      const rank = (arr: Float64Array) => { const idx = [...arr.keys()].sort((i, j) => arr[j] - arr[i]); const r = new Float64Array(arr.length); idx.forEach((ci, k) => r[ci] = k + 1); return r; };
      const z = (arr: Float64Array) => { let m = 0; for (const v of arr) m += v; m /= arr.length; let s = 0; for (const v of arr) s += (v - m) ** 2; s = Math.sqrt(s / arr.length) || 1; const o = new Float64Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = (arr[i] - m) / s; return o; };
      const rb = rank(b), rx = rank(x), zb = z(b), zx = z(x);
      const docScore = new Map<string, number>();
      for (let ci = 0; ci < chunks.length; ci++) {
        const s = combine(b[ci], x[ci], rb[ci], rx[ci], zb[ci], zx[ci]);
        if (s > (docScore.get(docOf[ci]) ?? -1e9)) docScore.set(docOf[ci], s);
      }
      const ranked = [...docScore.entries()].sort((a, c) => c[1] - a[1]).map((e) => e[0]);
      const rk = ranked.indexOf(gold) + 1;
      if (rk > 0) { mrr += 1 / rk; for (const k of KS) if (rk <= k) hit[k]++; }
    }
    const n = rows.length;
    console.log(`${label.padEnd(22)} ` + KS.map((k) => `${(hit[k] / n * 100).toFixed(1)}%`.padStart(7)).join(" ") + `   MRR=${(mrr / n).toFixed(3)}  P@1=${(hit[1] / n * 100).toFixed(1)}%`);
  }

  console.log(`\nfusion sweep (ctx=${useLoc ? "LOCATOR" : "BLURB"})  ` + KS.map((k) => `R@${k}`.padStart(7)).join(" "));
  sweep("max", (b, x) => Math.max(b, x));
  sweep("sum", (b, x) => b + x);
  sweep("product", (b, x) => clamp(b) * clamp(x));
  sweep("min (strict AND)", (b, x) => Math.min(b, x));
  sweep("weighted .7b/.3x", (b, x) => 0.7 * b + 0.3 * x);
  sweep("weighted .3b/.7x", (b, x) => 0.3 * b + 0.7 * x);
  sweep("z-sum (norm)", (_b, _x, _rb, _rx, zb, zx) => zb + zx);
  sweep("RRF (k=60)", (_b, _x, rb, rx) => 1 / (60 + rb) + 1 / (60 + rx));
  sweep("RRF (k=10)", (_b, _x, rb, rx) => 1 / (10 + rb) + 1 / (10 + rx));
}
main().catch((e) => { console.error(e); process.exit(1); });
