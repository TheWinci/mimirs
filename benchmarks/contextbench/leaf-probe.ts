/**
 * Cheap iteration probe: sweep leaf-only retrieval configs (top, threshold) and
 * measure content chars returned + whether the KEY subsystem files are still
 * surfaced — WITHOUT spawning agents. Fast loop for tuning the token lever.
 *
 * Run: bun benchmarks/contextbench/leaf-probe.ts [repoDir]
 */
import { RagDB } from "../../src/db";
import { loadConfig } from "../../src/config";
import { searchChunks } from "../../src/search/hybrid";

const repoDir = process.argv[2] ?? "/tmp/cb-arena/repo";

// Sub-queries an agent issues while understanding this subsystem.
const QUERIES = [
  "coordinate frame transformation graph register transform",
  "transform graph shortest path routing between frames dijkstra",
  "ITRS to AltAz HADec observed transform",
  "FunctionTransformWithFiniteDifference CoordinateTransform transform classes",
  "frame_transform_graph add_transform decorator register",
  "CompositeTransform chain transforms intermediate frame attributes",
];

// Files a correct answer must surface (cited by the good agent answers).
const KEY = [
  "astropy/coordinates/transformations.py",
  "astropy/coordinates/baseframe.py",
  "astropy/coordinates/builtin_frames/itrs.py",
  "astropy/coordinates/builtin_frames/altaz.py",
  "astropy/coordinates/builtin_frames/hadec.py",
  "astropy/coordinates/builtin_frames/icrs_observed_transforms.py",
  "astropy/coordinates/builtin_frames/cirs_observed_transforms.py",
  "astropy/coordinates/builtin_frames/intermediate_rotation_transforms.py",
];

async function run(db: RagDB, hybridWeight: number, generated: string[], pgmc: number, leafOnly: boolean, top: number, threshold: number) {
  let chars = 0, chunks = 0, maxC = 0;
  const seen = new Set<string>();
  for (const q of QUERIES) {
    const res = await searchChunks(q, db, top, threshold, hybridWeight, generated, undefined, pgmc, leafOnly);
    for (const c of res) {
      chars += c.content.length; chunks++; maxC = Math.max(maxC, c.content.length);
      const rel = c.path.startsWith(repoDir) ? c.path.slice(repoDir.length + 1) : c.path;
      seen.add(rel);
    }
  }
  const keyCov = KEY.filter((f) => seen.has(f)).length / KEY.length;
  return { chars, chunks, maxC, keyCov };
}

async function main() {
  const db = new RagDB(repoDir);
  const config = await loadConfig(repoDir);
  const { hybridWeight, generated, parentGroupingMinCount: pgmc } = config;
  console.log(`Probe on ${repoDir} (${QUERIES.length} queries); KEY files=${KEY.length}\n`);
  console.log(`mode        top thr   chars   chunks maxChunk keyCov`);
  const configs: [string, boolean, number, number][] = [
    ["default", false, 8, 0.3],
    ["leaf", true, 8, 0.3],
    ["leaf", true, 5, 0.3],
    ["leaf", true, 4, 0.3],
    ["leaf", true, 3, 0.3],
    ["leaf", true, 5, 0.4],
    ["leaf", true, 4, 0.4],
    ["leaf", true, 3, 0.45],
  ];
  for (const [mode, leaf, top, thr] of configs) {
    const r = await run(db, hybridWeight, generated, pgmc, leaf, top, thr);
    console.log(`${mode.padEnd(10)} ${String(top).padStart(2)} ${thr.toFixed(2)}  ${String(r.chars).padStart(7)}  ${String(r.chunks).padStart(5)}  ${String(r.maxC).padStart(7)}  ${(r.keyCov*100).toFixed(0)}%`);
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
