// Benchmark: different approaches to collecting files for indexing.
//
// Approaches tested:
//   1. Current: multiple glob.scan() calls (one per include pattern)
//   2. Single readdir({ recursive: true }) + Glob.match() filtering
//   3. Single readdir + fast extension/basename check (no Glob.match)
//   4. Single glob.scan + Glob.match() filtering
//   5. readdir + all-fast (no Glob anywhere)
//
// Run: bun benchmarks/collect-files-bench.ts [directory]

import { Glob } from "bun";
import { readdir } from "fs/promises";
import { relative, resolve, extname, basename } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INCLUDE_PATTERNS = [
  "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx",
  "**/*.py",
  "**/*.go",
  "**/*.rs",
  "**/*.java",
  "**/*.c", "**/*.h",
  "**/*.cpp", "**/*.cc", "**/*.cxx", "**/*.hpp", "**/*.hh", "**/*.hxx",
  "**/*.cs",
  "**/*.rb",
  "**/*.php",
  "**/*.scala", "**/*.sc",
  "**/*.swift",
  "**/*.md", "**/*.mdx", "**/*.markdown", "**/*.txt",
  "**/Makefile", "**/makefile", "**/GNUmakefile",
  "**/Dockerfile", "**/Dockerfile.*",
  "**/Jenkinsfile", "**/Jenkinsfile.*",
  "**/Vagrantfile", "**/Gemfile", "**/Rakefile",
  "**/Brewfile", "**/Procfile",
  "**/*.sh", "**/*.bash", "**/*.zsh", "**/*.fish",
  "**/*.yaml", "**/*.yml",
  "**/*.toml",
  "**/*.xml",
  "**/*.tf",
  "**/*.proto",
  "**/*.graphql", "**/*.gql",
  "**/*.sql",
  "**/*.mod",
  "**/*.bru",
];

const EXCLUDE_PATTERNS = ["node_modules/**", ".git/**", "dist/**", ".rag/**"];

const WARMUP_RUNS = 2;
const BENCH_RUNS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesAny(filePath: string, globs: Glob[]): boolean {
  return globs.some((g) => g.match(filePath));
}

function isExcluded(rel: string, excludeGlobs: Glob[]): boolean {
  return excludeGlobs.some((g) => g.match(rel));
}

// Build a Set of known extensions and special basenames from the patterns
// for a fast pre-filter before running glob matching
function buildFastFilter(patterns: string[]): { extensions: Set<string>; basenames: Set<string>; basenamePrefixes: string[] } {
  const extensions = new Set<string>();
  const basenames = new Set<string>();
  const basenamePrefixes: string[] = [];

  for (const p of patterns) {
    // Pattern like "**/*.ts" -> extension ".ts"
    const extMatch = p.match(/^\*\*\/\*(\.\w+)$/);
    if (extMatch) {
      extensions.add(extMatch[1]);
      continue;
    }
    // Pattern like "**/Makefile" -> basename "Makefile"
    const baseMatch = p.match(/^\*\*\/([A-Za-z]\w*)$/);
    if (baseMatch) {
      basenames.add(baseMatch[1]);
      continue;
    }
    // Pattern like "**/Dockerfile.*" -> prefix "Dockerfile"
    const prefixMatch = p.match(/^\*\*\/([A-Za-z]\w*)\.\*$/);
    if (prefixMatch) {
      basenamePrefixes.push(prefixMatch[1] + ".");
      continue;
    }
  }
  return { extensions, basenames, basenamePrefixes };
}

// ---------------------------------------------------------------------------
// Approach 1: Current — multiple glob.scan()
// ---------------------------------------------------------------------------

async function approach1_multiGlobScan(directory: string): Promise<string[]> {
  const excludeGlobs = EXCLUDE_PATTERNS.map((p) => new Glob(p));
  const seen = new Set<string>();

  for (const pattern of INCLUDE_PATTERNS) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: directory, absolute: true })) {
      const rel = relative(directory, file);
      if (!isExcluded(rel, excludeGlobs) && !seen.has(file)) {
        seen.add(file);
      }
    }
  }

  return [...seen];
}

// ---------------------------------------------------------------------------
// Approach 2: Single readdir({ recursive: true }) + Glob.match()
// ---------------------------------------------------------------------------

async function approach2_readdirMatch(directory: string): Promise<string[]> {
  const includeGlobs = INCLUDE_PATTERNS.map((p) => new Glob(p));
  const excludeGlobs = EXCLUDE_PATTERNS.map((p) => new Glob(p));

  const allFiles = await readdir(directory, { recursive: true });
  const results: string[] = [];

  for (const rel of allFiles) {
    if (isExcluded(rel, excludeGlobs)) continue;
    if (matchesAny(rel, includeGlobs)) {
      results.push(resolve(directory, rel));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Approach 3: Single readdir + fast extension/basename check (no Glob.match)
// ---------------------------------------------------------------------------

async function approach3_readdirFastFilter(directory: string): Promise<string[]> {
  const { extensions, basenames, basenamePrefixes } = buildFastFilter(INCLUDE_PATTERNS);
  const excludeGlobs = EXCLUDE_PATTERNS.map((p) => new Glob(p));

  const allFiles = await readdir(directory, { recursive: true });
  const results: string[] = [];

  for (const rel of allFiles) {
    if (isExcluded(rel, excludeGlobs)) continue;

    const ext = extname(rel);
    const base = basename(rel);

    if (extensions.has(ext) || basenames.has(base) || basenamePrefixes.some((p) => base.startsWith(p))) {
      results.push(resolve(directory, rel));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Approach 4: Single glob.scan("**/*") + Glob.match() filtering
// ---------------------------------------------------------------------------

async function approach4_singleGlobScan(directory: string): Promise<string[]> {
  const includeGlobs = INCLUDE_PATTERNS.map((p) => new Glob(p));
  const excludeGlobs = EXCLUDE_PATTERNS.map((p) => new Glob(p));

  const glob = new Glob("**/*");
  const results: string[] = [];

  for await (const file of glob.scan({ cwd: directory, absolute: true })) {
    const rel = relative(directory, file);
    if (isExcluded(rel, excludeGlobs)) continue;
    if (matchesAny(rel, includeGlobs)) {
      results.push(file);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Approach 5: readdir + fast filter, but exclude via string prefix instead of Glob
// ---------------------------------------------------------------------------

async function approach5_readdirAllFast(directory: string): Promise<string[]> {
  const { extensions, basenames, basenamePrefixes } = buildFastFilter(INCLUDE_PATTERNS);

  // Convert exclude patterns to simple prefix checks where possible
  const excludePrefixes = EXCLUDE_PATTERNS
    .map((p) => p.replace(/\/?\*\*$/, "").replace(/\/$/, ""))
    .filter(Boolean);

  const allFiles = await readdir(directory, { recursive: true });
  const results: string[] = [];

  for (const rel of allFiles) {
    // Fast prefix exclude check
    let excluded = false;
    for (const prefix of excludePrefixes) {
      if (rel.startsWith(prefix + "/") || rel === prefix) {
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    const ext = extname(rel);
    const base = basename(rel);

    if (extensions.has(ext) || basenames.has(base) || basenamePrefixes.some((p) => base.startsWith(p))) {
      results.push(resolve(directory, rel));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  fileCount: number;
}

async function bench(
  name: string,
  fn: (dir: string) => Promise<string[]>,
  directory: string
): Promise<BenchResult> {
  // Warmup
  let fileCount = 0;
  for (let i = 0; i < WARMUP_RUNS; i++) {
    const r = await fn(directory);
    fileCount = r.length;
  }

  // Benchmark
  const times: number[] = [];
  for (let i = 0; i < BENCH_RUNS; i++) {
    const start = performance.now();
    await fn(directory);
    times.push(performance.now() - start);
  }

  return {
    name,
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    fileCount,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const directory = resolve(process.argv[2] || ".");
console.log(`\nBenchmarking file collection in: ${directory}`);
console.log(`Include patterns: ${INCLUDE_PATTERNS.length}`);
console.log(`Warmup runs: ${WARMUP_RUNS}, Bench runs: ${BENCH_RUNS}\n`);

// Count total FS entries for context
const totalEntries = (await readdir(directory, { recursive: true })).length;
console.log(`Total filesystem entries (readdir recursive): ${totalEntries.toLocaleString()}\n`);

const approaches: [string, (dir: string) => Promise<string[]>][] = [
  ["1. Multi glob.scan() (current)", approach1_multiGlobScan],
  ["2. readdir + Glob.match()", approach2_readdirMatch],
  ["3. readdir + fast ext/basename", approach3_readdirFastFilter],
  ["4. Single glob.scan(**/*) + match", approach4_singleGlobScan],
  ["5. readdir + all-fast (no Glob)", approach5_readdirAllFast],
];

const results: BenchResult[] = [];

for (const [name, fn] of approaches) {
  process.stdout.write(`Running: ${name}...`);
  const r = await bench(name, fn, directory);
  results.push(r);
  console.log(` done (${r.fileCount} files, avg ${r.avgMs.toFixed(1)}ms)`);
}

console.log("\n" + "=".repeat(75));
console.log("RESULTS");
console.log("=".repeat(75));
console.log(
  `${"Approach".padEnd(42)} ${"Files".padStart(6)} ${"Avg".padStart(9)} ${"Min".padStart(9)} ${"Max".padStart(9)}`
);
console.log("-".repeat(75));

for (const r of results) {
  console.log(
    `${r.name.padEnd(42)} ${String(r.fileCount).padStart(6)} ${(r.avgMs.toFixed(1) + "ms").padStart(9)} ${(r.minMs.toFixed(1) + "ms").padStart(9)} ${(r.maxMs.toFixed(1) + "ms").padStart(9)}`
  );
}

// Verify all approaches found the same files
const baseline = new Set((await approach1_multiGlobScan(directory)).sort());
for (const [name, fn] of approaches.slice(1)) {
  const found = new Set((await fn(directory)).sort());
  const missing = [...baseline].filter((f) => !found.has(f));
  const extra = [...found].filter((f) => !baseline.has(f));
  if (missing.length > 0 || extra.length > 0) {
    console.log(`\n⚠ ${name}: MISMATCH vs baseline`);
    if (missing.length > 0) console.log(`  Missing ${missing.length}: ${missing.slice(0, 5).map(f => relative(directory, f)).join(", ")}${missing.length > 5 ? "..." : ""}`);
    if (extra.length > 0) console.log(`  Extra ${extra.length}: ${extra.slice(0, 5).map(f => relative(directory, f)).join(", ")}${extra.length > 5 ? "..." : ""}`);
  }
}

console.log("\nDone.\n");
