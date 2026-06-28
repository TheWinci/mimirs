/**
 * Embedding-model A/B on the ContextBench cb-repos — the RIGHT instrument for the
 * "is the small model the wall?" question. Unlike benchmarks/model-ab.ts (single
 * repo, curated query lists, file-recall@10/MRR), this scores against the SWE-bench
 * gold using cb-score.ts's exact methodology: distilled-query retrieval, fixed-8/12
 * file cov/prec, leaf-chunk line cov/prec, and gold-file rank R@8/@10/@12 — where
 * R@10 is the measured wall (~59% on the default MiniLM).
 *
 * How it stays honest:
 *  - each arm indexes into a THROWAWAY rag dir under /tmp, so the cb-repos' own
 *    .mimirs indexes are never touched and nothing is deleted (no DB-delete risk).
 *  - a fresh dir per arm forces a FULL re-embed: the indexer skips files by content
 *    hash, so re-indexing a same-dim model into an existing db would silently keep
 *    the old model's vectors. A clean dir dodges that.
 *  - the embedder is driven EXPLICITLY (configureEmbedder before construction so the
 *    vec table is built at the arm's dim) with autoEmbeddingConfig:false so RagDB's
 *    constructor doesn't reset it from the repo's config.json.
 *  - the BASELINE arm reproduces the known numbers, validating the harness before
 *    any candidate delta is trusted.
 *
 * All default arms are 384-dim drop-ins → no vec-table dim change, true cheap swap.
 *
 * CONFOUND: mimirs embeds query and document IDENTICALLY (symmetric). Instruction-
 * tuned / asymmetric models (bge, e5, arctic) expect a query-side prefix and are
 * handicapped here. gte-small is the cleanest no-prefix candidate. Arms that need a
 * prefix are flagged (*) in the output — read their deltas as a FLOOR, not a verdict.
 *
 * Run (full, slow — 15 repos x N arms full index builds):
 *   MIMIRS_ALLOW_CUSTOM_MODEL=1 bun benchmarks/contextbench/cb-model-ab.ts
 * Smoke (wiring check — 2 small repos, baseline + one candidate):
 *   MIMIRS_ALLOW_CUSTOM_MODEL=1 bun benchmarks/contextbench/cb-model-ab.ts --smoke
 * Filter arms / repos:
 *   ... --arms=0,1 --repos=flask-2e76c8cd,pylint-1409977d
 */
import { readFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { search, searchChunks } from "../../src/search/hybrid";
import { configureEmbedder, getEmbedder, getModelId } from "../../src/embeddings/embed";

const CB = "/Users/winci/repos/cb-repos";
const ROOT = join(tmpdir(), "mimirs-cb-modelab");
// Embed batch cap (chunks per forward pass). Default 8 keeps the wasm arena
// bounded on deeper models / big repos; override with --batch=N.
const BATCH = parseInt(argVal("batch") ?? process.env.CB_BATCH ?? "16", 10);

interface Inst {
  instance_id: string;
  dir: string;
  repo: string;
  problem_statement: string;
  gold: { file: string; start: number; end: number }[];
}

interface Arm {
  label: string;
  id: string;
  dim: number;
  pooling: "mean" | "cls" | "none";
  dtype?: string;
  /** Needs a query-side instruction prefix mimirs doesn't add → handicapped. */
  prefix?: boolean;
}

// Edit freely. Baseline MUST stay first (it validates the harness). All 384-dim.
const ARMS: Arm[] = [
  { label: "all-MiniLM-L6-v2 (384,mean) baseline", id: "Xenova/all-MiniLM-L6-v2", dim: 384, pooling: "mean", dtype: "q8" },
  { label: "gte-small        (384,mean)", id: "Xenova/gte-small", dim: 384, pooling: "mean", dtype: "q8" },
  { label: "bge-small-en-1.5 (384,cls)*", id: "Xenova/bge-small-en-v1.5", dim: 384, pooling: "cls", dtype: "q8", prefix: true },
  { label: "arctic-embed-s   (384,cls)*", id: "Snowflake/snowflake-arctic-embed-s", dim: 384, pooling: "cls", dtype: "q8", prefix: true },
  // CODE-SEARCH arm (arm 4): purpose-built NL<->code retrieval, symmetric (no
  // prefix needed) so it's a FAIR floor. 768-dim (vec table 2x storage if adopted)
  // and ~160M params (bigger -> use --batch=8 to bound the wasm arena).
  { label: "jina-v2-base-code(768,mean)", id: "jinaai/jina-embeddings-v2-base-code", dim: 768, pooling: "mean", dtype: "q8" },
];

const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

function argVal(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

interface ArmResult {
  label: string;
  ok: boolean;
  note?: string;
  // distilled-mode aggregates (the wall metric)
  c8: number; p8: number; c12: number; p12: number; lc: number; lp: number;
  // gold-file rank coverage, micro over every gold file across all scored repos
  goldTot: number; r8: number; r10: number; r12: number;
  repos: number;
  sec: number;
}

async function scoreArm(arm: Arm, dirs: string[], dataset: Inst[], queries: Record<string, string>): Promise<ArmResult> {
  const res: ArmResult = { label: arm.label, ok: false, c8: 0, p8: 0, c12: 0, p12: 0, lc: 0, lp: 0, goldTot: 0, r8: 0, r10: 0, r12: 0, repos: 0, sec: 0 };
  const t0 = performance.now();

  // Drive the embedder ourselves: configure BEFORE any RagDB so the vec table is
  // built at this arm's dim. Warm it now so download/load errors surface here (and
  // are excluded from per-repo timing). Fall back q8 -> fp32 if the variant is absent.
  configureEmbedder(arm.id, arm.dim, arm.pooling, arm.dtype ?? "q8");
  try {
    await getEmbedder();
  } catch (e) {
    if ((arm.dtype ?? "q8") === "q8") {
      configureEmbedder(arm.id, arm.dim, arm.pooling, "fp32");
      try {
        await getEmbedder();
      } catch (e2) {
        res.note = `load failed (q8 and fp32): ${String(e2 instanceof Error ? e2.message : e2).slice(0, 120)}`;
        return res;
      }
    } else {
      res.note = `load failed: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`;
      return res;
    }
  }
  if (getModelId() !== arm.id) {
    res.note = `embedder is ${getModelId()}, expected ${arm.id} — custom model gate? set MIMIRS_ALLOW_CUSTOM_MODEL=1`;
    return res;
  }

  for (const g of dataset) {
    if (!dirs.includes(g.dir)) continue;
    const repoDir = `${CB}/${g.dir}`;
    const armRagDir = join(ROOT, sanitize(arm.id), g.dir);
    rmSync(armRagDir, { recursive: true, force: true });
    mkdirSync(armRagDir, { recursive: true });

    const cfg = await loadConfig(repoDir); // py-only, tests-excluded filters live here
    // Cap the embed batch: embedBatchMerged flattens every 256-tok window of a
    // batch into ONE forward pass (embed.ts), so a big batch on a deeper model
    // (gte-small = 2x MiniLM layers) blows the wasm arena to ~10GB on large repos.
    // Batch size does NOT change embedding values (each text is pooled
    // independently), so this is comparison-safe — just bounds memory.
    cfg.indexBatchSize = BATCH;
    // autoEmbeddingConfig:false — do NOT let the constructor reload the embedder
    // from the repo's config.json (would reset us to the default model).
    const db = new RagDB(repoDir, armRagDir, { autoEmbeddingConfig: false });
    try {
      await indexInto(repoDir, db, cfg);

      const goldFiles = [...new Set(g.gold.map((x) => x.file))];
      const goldLines = new Map<string, Set<number>>();
      for (const x of g.gold) {
        const s = goldLines.get(x.file) ?? new Set<number>();
        for (let i = x.start; i <= x.end; i++) s.add(i);
        goldLines.set(x.file, s);
      }
      const totGold = [...goldLines.values()].reduce((a, s) => a + s.size, 0);
      const rel = (p: string) => (p.startsWith(repoDir + "/") ? p.slice(repoDir.length + 1) : p);

      const q = queries[g.dir] ?? g.problem_statement; // distilled = the real input
      // Identical to cb-score.ts: 60-deep pool, slice fixed-8/12.
      const ranked = (await search(q, db, 60, 0, cfg.hybridWeight, cfg.generated)).map((r) => rel(r.path));
      const cp = (k: number) => {
        const pred = ranked.slice(0, k);
        const inter = pred.filter((f) => goldFiles.some((gf) => hit(f, gf))).length;
        return {
          cov: goldFiles.length ? goldFiles.filter((gf) => pred.some((f) => hit(f, gf))).length / goldFiles.length : 0,
          prec: pred.length ? inter / pred.length : 0,
        };
      };
      const f8 = cp(8), f12 = cp(12);
      const chunks = await searchChunks(q, db, 10, 0.3, cfg.hybridWeight, cfg.generated, undefined, cfg.parentGroupingMinCount, cfg.leafOnly, false, cfg.chunkParentBoost, cfg.chunkRelCutoff, cfg.chunkSteepSkip);
      let predLines = 0, hitLines = 0;
      const goldHit = new Set<string>();
      for (const c of chunks) {
        if (c.startLine == null || c.endLine == null) continue;
        const rp = rel(c.path);
        const gl = goldLines.get(rp);
        for (let i = c.startLine; i <= c.endLine; i++) {
          predLines++;
          if (gl?.has(i)) { hitLines++; goldHit.add(`${rp}:${i}`); }
        }
      }

      res.c8 += f8.cov; res.p8 += f8.prec; res.c12 += f12.cov; res.p12 += f12.prec;
      res.lc += totGold ? goldHit.size / totGold : 0;
      res.lp += predLines ? hitLines / predLines : 0;
      // gold-file rank coverage, micro: each gold file counts once toward R@K.
      for (const gf of goldFiles) {
        res.goldTot++;
        let rank = 0;
        for (let i = 0; i < ranked.length; i++) if (hit(ranked[i], gf)) { rank = i + 1; break; }
        if (rank > 0 && rank <= 8) res.r8++;
        if (rank > 0 && rank <= 10) res.r10++;
        if (rank > 0 && rank <= 12) res.r12++;
      }
      res.repos++;
    } finally {
      db.close();
    }
    rmSync(armRagDir, { recursive: true, force: true });
  }

  res.ok = res.repos > 0;
  res.sec = (performance.now() - t0) / 1000;
  return res;
}

// indexDirectory lives in the indexer; imported lazily to keep the heavy module out
// of the hot path until an arm actually runs.
async function indexInto(repoDir: string, db: RagDB, cfg: Awaited<ReturnType<typeof loadConfig>>) {
  const { indexDirectory } = await import("../../src/indexing/indexer");
  await indexDirectory(repoDir, db, cfg, () => {});
}

function sanitize(id: string) {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function main() {
  const dataset = JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[];
  const queries = JSON.parse(readFileSync(`${CB}/queries.json`, "utf8")) as Record<string, string>;
  dataset.sort((a, b) => a.dir.localeCompare(b.dir));

  const smoke = process.argv.includes("--smoke");
  const armFilter = argVal("arms");
  const repoFilter = argVal("repos");

  let arms = ARMS;
  if (smoke) arms = [ARMS[0], ARMS[1]];
  if (armFilter) {
    const idx = new Set(armFilter.split(",").map((s) => parseInt(s, 10)));
    arms = ARMS.filter((_, i) => idx.has(i));
  }

  let dirs = dataset.map((d) => d.dir);
  if (repoFilter) {
    const want = new Set(repoFilter.split(","));
    dirs = dirs.filter((d) => want.has(d));
  } else if (smoke) {
    // two of the smaller repos for a fast wiring check
    dirs = dirs.filter((d) => d.startsWith("flask-") || d.startsWith("pylint-")).slice(0, 2);
  }

  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  console.log(`ContextBench model A/B — ${arms.length} arms x ${dirs.length} repos, distilled queries`);
  console.log(`repos: ${dirs.join(", ")}\n`);

  const results: ArmResult[] = [];
  for (const arm of arms) {
    process.stdout.write(`indexing+scoring ${arm.label} ... `);
    const r = await scoreArm(arm, dirs, dataset, queries);
    console.log(r.ok ? `done (${r.sec.toFixed(0)}s, ${r.repos} repos)` : `SKIP — ${r.note}`);
    results.push(r);
  }

  const n = (r: ArmResult) => r.repos || 1;
  const pct = (v: number, r: ArmResult) => (v / n(r) * 100).toFixed(1).padStart(6) + "%";
  const rk = (hits: number, tot: number) => (tot ? (hits / tot * 100).toFixed(1) : "  0.0").padStart(5) + "%";

  console.log("\n" + "=".repeat(104));
  console.log(`${"model".padEnd(38)} ${"R@8".padStart(6)} ${"R@10".padStart(6)} ${"R@12".padStart(6)}  ${"fCov@8".padStart(7)} ${"fCov@12".padStart(7)} ${"linePrec".padStart(8)}  ${"time".padStart(5)}`);
  console.log("-".repeat(104));
  for (const r of results) {
    if (!r.ok) { console.log(`${r.label.padEnd(38)} SKIP — ${r.note}`); continue; }
    console.log(
      `${r.label.padEnd(38)} ${rk(r.r8, r.goldTot)} ${rk(r.r10, r.goldTot)} ${rk(r.r12, r.goldTot)}  ` +
      `${pct(r.c8, r)} ${pct(r.c12, r)} ${pct(r.lp, r)}  ${(r.sec.toFixed(0) + "s").padStart(5)}`
    );
  }

  // Delta vs baseline (first OK arm) on the headline R@10.
  const base = results.find((r) => r.ok);
  if (base) {
    console.log("-".repeat(104));
    const baseR10 = base.goldTot ? base.r10 / base.goldTot : 0;
    for (const r of results) {
      if (!r.ok || r === base) continue;
      const d = (r.goldTot ? r.r10 / r.goldTot : 0) - baseR10;
      const sign = d >= 0 ? "+" : "";
      console.log(`  ${r.label.padEnd(38)} R@10 ${sign}${(d * 100).toFixed(1)} pts vs baseline${r.label.includes("*") ? "  (handicapped: no query prefix)" : ""}`);
    }
  }
  console.log("\nR@10 is the wall. '*' arms embed query==doc without their expected prefix — treat as a floor.");
  console.log("If a no-prefix arm (gte-small) clears baseline meaningfully, the small model IS the wall → upgrade worth the re-embed.");

  rmSync(ROOT, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
