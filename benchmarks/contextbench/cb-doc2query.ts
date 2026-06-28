/**
 * doc2query probe: does embedding QUERY-STYLE text (the behavior phrases a
 * searcher would type to find a chunk) beat embedding the raw body — and does it
 * beat the Anthropic situating-blurb? Tests doc2query both as a STANDALONE vector
 * (replaces body) and as a SECOND vector max-fused with the body (the dual-vector
 * shape that won in cb-dualvec).
 *
 * Dense-only, offline, doc-level recall@k over the Anthropic bench corpus — same
 * instrument as cb-dualvec.ts. Blurbs/doc2query keyed by mimirs content_hash.
 *
 * Run on the two query populations the query-phrasing finding contrasts:
 *   bun benchmarks/contextbench/cb-doc2query.ts                                  # human questions
 *   QUERY_FILE=.cb-anthropic/queries_agent.json bun benchmarks/contextbench/cb-doc2query.ts  # agent-style
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
  const d2q = JSON.parse(readFileSync(`${DATA}/doc2query.json`, "utf8")) as Record<string, string>;

  const uuidByFile = new Map<string, string>();
  for (const r of rows) for (const gd of r.golden_documents)
    uuidByFile.set(`${gd.meta.repo_name}/${gd.meta.relative_path.replace(/^\/+/, "")}`, gd.uuid);

  const db = new RagDB(CORPUS);
  const prefix = `${CORPUS.replace(/\/$/, "")}/`;
  const chunks = (db as unknown as { db: { query(s: string): { all(): unknown[] } } }).db.query(
    `SELECT c.snippet AS snippet, c.content_hash AS hash, f.path AS path
     FROM chunks c JOIN files f ON f.id = c.file_id WHERE c.chunk_index >= 0`
  ).all() as { snippet: string; hash: string | null; path: string }[];
  db.close();

  const docOf = chunks.map((c) => uuidByFile.get(c.path.startsWith(prefix) ? c.path.slice(prefix.length) : c.path) ?? "?");
  const blurbText = chunks.map((c) => (c.hash && blurbs[c.hash]) || "");
  const d2qText = chunks.map((c) => (c.hash && d2q[c.hash]) || "");
  const d2qCov = d2qText.filter(Boolean).length;

  const qOverride: (string | null)[] | null = process.env.QUERY_FILE ? JSON.parse(readFileSync(process.env.QUERY_FILE, "utf8")) : null;
  const qSet = qOverride ? `AGENT-style (${process.env.QUERY_FILE!.split("/").pop()})` : "HUMAN questions";

  console.log(`doc2query probe — ${qSet}`);
  console.log(`embedding ${chunks.length} bodies / blurbs / doc2query + ${rows.length} queries  (d2q coverage ${d2qCov}/${chunks.length}) ...`);
  const bodyVec = await embedBatchMerged(chunks.map((c) => c.snippet), undefined, () => {});
  const blurbVec = await embedBatch(blurbText.map((b) => b || "x"), undefined, () => {});
  const d2qVec = await embedBatch(d2qText.map((b) => b || "x"), undefined, () => {});
  const qVec = await embedBatch(rows.map((r, i) => (qOverride?.[i]) || r.query), undefined, () => {});

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
    const fail20 = (100 - hit[20] / n * 100).toFixed(1);
    console.log(`${label.padEnd(24)} ${cells}   MRR=${(mrr / n).toFixed(3)}  fail@20=${fail20}%`);
  }

  console.log(`\narm                      ` + KS.map((k) => `R@${k}`.padStart(7)).join(" "));
  evalArm("BODY only", (q, c) => cos(qVec[q], bodyVec[c]));
  evalArm("BLURB vec only", (q, c) => (blurbText[c] ? cos(qVec[q], blurbVec[c]) : -1));
  evalArm("DOC2QUERY vec only", (q, c) => (d2qText[c] ? cos(qVec[q], d2qVec[c]) : -1));
  evalArm("BODY + BLURB (max)", (q, c) => Math.max(cos(qVec[q], bodyVec[c]), blurbText[c] ? cos(qVec[q], blurbVec[c]) : -1));
  evalArm("BODY + DOC2QUERY (max)", (q, c) => Math.max(cos(qVec[q], bodyVec[c]), d2qText[c] ? cos(qVec[q], d2qVec[c]) : -1));
  evalArm("BODY + BLURB + D2Q (max)", (q, c) => Math.max(
    cos(qVec[q], bodyVec[c]),
    blurbText[c] ? cos(qVec[q], blurbVec[c]) : -1,
    d2qText[c] ? cos(qVec[q], d2qVec[c]) : -1));
}
main().catch((e) => { console.error(e); process.exit(1); });
