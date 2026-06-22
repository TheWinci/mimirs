/**
 * Joins the grep-only agent baseline (15 Explore subagents, raw issue, no gold,
 * no mimirs, no git-peek) against the mimirs single-call cost side. Scores each
 * agent's localized file set vs gold and compares the path-to-gold:
 * mimirs returns the gold cluster in ONE call; the agent burns N grep/read calls
 * and typically stops at the primary file, leaving secondary gold unfound.
 *
 * Agent results pasted from the spawned runs; mimirs gold@8 + call cost from
 * cb-cost.ts. Run: bun benchmarks/contextbench/cb-agent-score.ts
 */
import { readFileSync } from "fs";
const CB = "/Users/winci/repos/cb-repos";
const hit = (p: string, e: string) => p === e || p.endsWith("/" + e) || p.endsWith(e);

// agent baseline: { files localized, tool calls made }
const agent: Record<string, { files: string[]; tc: number }> = {
  "astropy-71f348da": { files: ["astropy/wcs/wcsapi/wrappers/sliced_wcs.py"], tc: 9 },
  "astropy-deb49033": { files: ["astropy/coordinates/builtin_frames/itrs_observed_transforms.py", "astropy/coordinates/builtin_frames/__init__.py"], tc: 14 },
  "django-1a760e52": { files: ["django/contrib/auth/validators.py"], tc: 11 },
  "django-93721db4": { files: ["django/db/models/aggregates.py"], tc: 10 },
  "flask-2e76c8cd": { files: ["src/flask/blueprints.py", "tests/test_blueprints.py"], tc: 11 },
  "matplotlib-5d44a351": { files: ["lib/matplotlib/widgets.py"], tc: 13 },
  "matplotlib-bebfd692": { files: ["lib/matplotlib/scale.py"], tc: 11 },
  "pylint-1409977d": { files: ["pylint/checkers/variables.py"], tc: 10 },
  "pylint-da598baa": { files: ["pylint/config/argument.py"], tc: 13 },
  "pytest-abb9b8b0": { files: ["src/_pytest/unittest.py"], tc: 13 },
  "pytest-e5236b5f": { files: ["src/_pytest/mark/structures.py"], tc: 12 },
  "requests-88e1ffd3": { files: ["requests/models.py"], tc: 6 },
  "requests-e989ba2d": { files: ["requests/utils.py"], tc: 15 },
  "xarray-42c77239": { files: ["xarray/core/variable.py"], tc: 12 },
  "xarray-90532e38": { files: ["xarray/core/weighted.py"], tc: 13 },
};
// mimirs single-call gold@8 (from cb-cost.ts)
const mimirsAt8: Record<string, number> = {
  "astropy-71f348da": 1, "astropy-deb49033": 5, "django-1a760e52": 1, "django-93721db4": 1,
  "flask-2e76c8cd": 1, "matplotlib-5d44a351": 1, "matplotlib-bebfd692": 3, "pylint-1409977d": 1,
  "pylint-da598baa": 1, "pytest-abb9b8b0": 1, "pytest-e5236b5f": 1, "requests-88e1ffd3": 1,
  "requests-e989ba2d": 2, "xarray-42c77239": 2, "xarray-90532e38": 1,
};

interface Inst { dir: string; gold: { file: string }[] }
const dataset = (JSON.parse(readFileSync(`${CB}/dataset.json`, "utf8")) as Inst[]).sort((a, b) => a.dir.localeCompare(b.dir));

let sGold = 0, sAgentFound = 0, sAgentTC = 0, sMimAt8 = 0;
console.log(`grep-only agent vs mimirs single call — gold localization\n`);
console.log(`instance              gold  agentFound  agentCalls   mimirsFound@8  mimirsCalls`);
for (const g of dataset) {
  const gold = [...new Set(g.gold.map((x) => x.file))];
  const a = agent[g.dir];
  const found = gold.filter((gf) => a.files.some((f) => hit(f, gf))).length;
  const m8 = mimirsAt8[g.dir];
  console.log(`${g.dir.padEnd(20)}  ${String(gold.length).padStart(3)}  ${String(found).padStart(7)}     ${String(a.tc).padStart(7)}      ${String(m8).padStart(7)}        ${String(1).padStart(6)}`);
  sGold += gold.length; sAgentFound += found; sAgentTC += a.tc; sMimAt8 += m8;
}
const n = dataset.length;
console.log(`\nTOTALS across ${n} issues, ${sGold} gold files:`);
console.log(`  grep agent : ${sAgentFound}/${sGold} gold found (${(sAgentFound / sGold * 100).toFixed(0)}%), ${sAgentTC} tool calls (mean ${(sAgentTC / n).toFixed(1)}/issue)`);
console.log(`  mimirs     : ${sMimAt8}/${sGold} gold in top-8 (${(sMimAt8 / sGold * 100).toFixed(0)}%), ${n} tool calls (1/issue), ~0 API tokens, ~10-22ms/call`);
console.log(`\nspeedup: ${(sAgentTC / n).toFixed(1)}x fewer tool calls per issue; agent stops at the primary file,`);
console.log(`mimirs surfaces the secondary/coupled gold in the same single call (multi-gold gap below).`);
console.log(`\nmulti-gold only (where mimirs' one-call cluster matters):`);
let mg = 0, mgGold = 0, mgA = 0, mgM = 0;
for (const g of dataset) {
  const gold = [...new Set(g.gold.map((x) => x.file))]; if (gold.length < 2) continue;
  const a = agent[g.dir]; const found = gold.filter((gf) => a.files.some((f) => hit(f, gf))).length;
  mg++; mgGold += gold.length; mgA += found; mgM += mimirsAt8[g.dir];
  console.log(`  ${g.dir.padEnd(20)} gold=${gold.length}  agent found ${found} (${a.tc} calls)  vs  mimirs ${mimirsAt8[g.dir]} @8 (1 call)`);
}
console.log(`  multi-gold subtotal: agent ${mgA}/${mgGold} (${(mgA / mgGold * 100).toFixed(0)}%)  vs  mimirs ${mgM}/${mgGold} (${(mgM / mgGold * 100).toFixed(0)}%)`);
