// Capture the pinned TS v2 implementation, without copying its algorithms.
// bun benchmarks/versions/port-reference.ts <extracted-v2> <new-output.json>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const revision = "122674c8bfbbc3549390743f51396c5f0e4e3537";
const [engineArgument, outputArgument] = process.argv.slice(2);
if (!engineArgument || !outputArgument) {
  throw new Error("usage: port-reference.ts <extracted-v2> <new-output.json>");
}
const engine = resolve(engineArgument);
const output = resolve(outputArgument);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const tree = spawnSync("git", ["ls-tree", "-r", revision, "--", "src", "packages", "bun.lock", "package.json"], {
  cwd: repository, encoding: "utf8",
});
if (tree.status !== 0) throw new Error(tree.stderr);
const sourceHashes: Record<string, string> = {};
for (const line of tree.stdout.trim().split("\n")) {
  const [metadata, path] = line.split("\t");
  const expected = metadata!.split(" ")[2];
  const bytes = readFileSync(resolve(engine, path!));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blob !== expected) throw new Error(`reference differs from ${revision}: ${path}`);
  sourceHashes[path!] = hash(bytes);
}

const load = (path: string) => import(resolve(engine, `src/internals/${path}.ts`));
const { SourceIndex } = await load("storage/source-index");
const { lexicalTerms, rankLexicalDocuments } = await load("search/lexical-search");
const { ftsQuery } = await load("storage/encoding");
const { searchCandidates, search } = await load("search/search");
const scoring = await load("search/scoring");
const grouping = await load("search/candidates");
const signals = await load("search/signals");
const config = await load("search/config");
const documentConfig = await load("search/documents/config");
const { sourceTextPreview } = await load("source/windows");
const { normalize } = await import(resolve(engine, "packages/chunk/src/source-text.ts"));

const texts = [
  "HTTPServer fooBar foo_bar v2 API x 7 007",
  "café cafe\u0301 ＡＰＩ Straße İSTANBUL Ωmega 你好",
  "quoted\" OR NEAR(foo) -- path:src/**/*.rs",
  "a I _ 🧭 !!!", "foo foo Foo", "STATIC_URL resolvePath pkg.ClassName",
];
const terms = texts.map(text => ({ text, terms: lexicalTerms(text), fts_query: ftsQuery(text) }));
const fusion = [[1, 1], [1, null], [null, 1], [3, 7], [null, null]].map(([semantic, lexical]) => ({
  semantic_rank: semantic, lexical_rank: lexical,
  score: scoring.reciprocalRankScore(semantic ?? undefined, lexical ?? undefined, 0.6, "current"),
}));
const signalInputs = ["resolvePath STATIC_URL", "find foo_bar", "the code get user", "pkg.ClassName"];
const generated = signals.generatedPathMatcher(["generated/**", "*.min.js"]);
const signalCases = {
  identifiers: signalInputs.map(query => ({ query, code: signals.extractCodeIdentifiers(query), definitions: signals.extractDefinitionIdentifiers(query) })),
  paths: ["src/test.rs", "src/tests/thing.rs", "test_worker.py", "worker_test.go", "src/worker.test.ts", "a/generated/file.ts", "a/b.min.js"].map(path => ({
    path, test: signals.isTestSourcePath(path), generated: generated(path),
  })),
};

// Shared source and synthetic vectors isolate storage/ranking from model drift.
const files = [
  { path: "src/alpha.ts", source: "export function resolvePath() { return 'manifest recovery'; }\nexport function recoverArchive() { return resolvePath(); }\n", vector: [0.8, 0.6] },
  { path: "src/beta.ts", source: "export function semanticOnly() { return 'other behavior'; }\n", vector: [1, 0] },
  { path: "src/generated/worker.ts", source: "export function resolvePath() { return 'manifest generated'; }\n", vector: [0.8, 0.6] },
  { path: "tests/worker.test.ts", source: "export function recoverArchive() { return 'manifest recovery'; }\n", vector: [0.6, 0.8] },
  { path: "src/unembedded.ts", source: "export function lexicalOnly() { return 'manifest recovery'; }\n", vector: null },
  { path: "docs/usage.md", source: "# Recover an archive\n\nManifest recovery uses [the implementation](../src/alpha.ts).\n", vector: [0, 1] },
  { path: "src/unicode.ts", source: "\ufeff// café 🧭\r\nexport function Café() { return 'cafe'; }\r", vector: [-1, 0] },
];
const embedder = {
  model: "fixture/controlled", revision: "1", variant: "two-dimensions", dimensions: 2,
  embed: async () => [new Float32Array([1, 0])],
};
const index = SourceIndex.open();
let nativeCases, windows, sqliteVersion, schema, previewCases, groupedCases, sourceCases;
try {
  sqliteVersion = index.database.query("SELECT sqlite_version() AS version").get().version;
  for (const file of files) {
    await index.indexFile(file.path, file.source);
    if (file.vector) index.storeWindowEmbeddings(embedder, index.loadWindows(file.path).map((window: any) => ({
      windowId: window.id, textHash: window.textHash, vector: new Float32Array(file.vector),
    })));
  }
  windows = files.flatMap(file => index.loadWindows(file.path).map((window: any) => ({
    ...window, fixtureVector: file.vector,
  })));
  schema = index.database.query("SELECT name, sql FROM sqlite_master WHERE name IN ('source_windows_fts', 'source_window_vectors') ORDER BY name").all();
  const requests = [
    { query: "manifest resolvePath", limit: 2, semanticLimit: 1 },
    { query: "lexicalOnly", limit: 1, semanticLimit: 1 },
    { query: "noSuchToken", limit: 100, semanticLimit: 150 },
    { query: "café", limit: 100, semanticLimit: 150 },
    { query: "\" OR NEAR(manifest) --", limit: 100, semanticLimit: 150 },
    { query: "recoverArchive", limit: 100, semanticLimit: 150 },
    { query: "a 🧭", limit: 100, semanticLimit: 150 },
  ];
  nativeCases = [];
  for (const request of requests) {
    const options = { lexicalMode: "current", semanticLimit: request.semanticLimit };
    const baseline = index.readNativeCandidates(embedder, new Float32Array([1, 0]), request.query, request.limit, options);
    const completed = index.readNativeCandidates(embedder, new Float32Array([1, 0]), request.query, request.limit, { ...options, completeMissingScores: true });
    const searchOptions = { embedder, generatedPatterns: ["generated/**"], candidateLimit: request.limit, semanticCandidateLimit: request.semanticLimit };
    const candidates = await searchCandidates(index, { query: request.query, maxResults: 5 }, searchOptions);
    const segmented = await search(index, { query: request.query, maxResults: 5 }, searchOptions);
    const referenceLexical = rankLexicalDocuments(request.query, windows.map((window: any) => ({
      id: window.id, path: window.path, name: window.sourceChunk.name, text: window.text, startOffset: window.startOffset,
    })));
    nativeCases.push({ request, baseline, completed, candidates, segmented, referenceLexical });
  }
  // Two windows of one chunk can supply the best rank in different channels.
  const seed = nativeCases[0].completed.semantic[0];
  const candidates = [
    { ...seed, id: 1001, path: "src/group.ts", text: "first part", semanticScore: 0.9, lexicalScore: 0.1 },
    { ...seed, id: 1002, path: "src/group.ts", text: "second part", startOffset: seed.startOffset + 20, semanticScore: 0.2, lexicalScore: 1 },
    { ...seed, id: 1003, path: "src/group.ts", text: "another owner", sourceChunk: { ...seed.sourceChunk, id: 9001 }, semanticScore: 0.5, lexicalScore: 0.5 },
  ];
  const semanticRanks = [[1001, 1], [1003, 2], [1002, 3]];
  const lexicalRanks = [[1002, 1], [1003, 2], [1001, 3]];
  const chunks = grouping.groupedCandidateHits(candidates, new Map(semanticRanks), new Map(lexicalRanks), true, 0.6, "current", 96, () => {});
  groupedCases = { candidates, semanticRanks, lexicalRanks, chunks, files: grouping.collapseCandidateFiles(chunks, 0.25) };
  previewCases = ["a\n  b\t🧭 café", "🧭".repeat(100)].map(text => ({ text, preview: sourceTextPreview(text), short: sourceTextPreview(text, 5) }));
  sourceCases = [];
  for (const [path, source] of [
    ["src/container.ts", `export class Worker {\n${Array.from({ length: 60 }, (_, i) => `  step${i}() { return 'recover manifest ${i}'; }`).join("\n")}\n}\n`],
    ["src/large.rs", `fn large() {\n${"    let content = \"literal 🧭 preserved\";\n".repeat(150)}}\n`],
    ["src/stub.pyi", "class Backend:\n    def build(self, path: str) -> str: ...\n"],
  ]) {
    await index.indexFile(path, source);
    sourceCases.push({ path, source, normalizedSource: normalize(source), windows: index.loadWindows(path) });
  }
} finally {
  index.close();
}

// Cached tokenizer only. No model inference and no downloads in this exporter.
const { env } = await import(resolve(engine, "node_modules/@huggingface/transformers/src/transformers.js"));
env.allowRemoteModels = false;
const miniLm = await load("embeddings/mini-lm");
const projected = [
  "File: src/alpha.ts\nexport function resolvePath() { return 'manifest'; }\n",
  `File: src/large.ts\n${"  const manifest = 'KeepLiteral_Case 🧭';\r\n".repeat(65)}`,
];
const tokenizer = await miniLm.getMiniLmTokenizer();
const plans = await miniLm.preparePathAverageMiniLmInputs(projected);
const tokenInputs = projected.map((text, i) => ({
  text, windows: plans[i].map((input: string) => ({ text: input, ids: Array.from(tokenizer.encode(input)) })),
}));
const report = {
  reference: { revision, bun: Bun.version, sqlite: sqliteVersion, sourceHashes },
  tolerances: { scalar_absolute: 1e-12, scalar_relative: 1e-9, native_cosine_absolute: 1e-6, model_component_absolute: 1e-5, model_minimum_cosine: 0.999999 },
  config, documentConfig: Object.fromEntries(Object.entries(documentConfig).filter(([, v]) => typeof v === "number")),
  terms, fusion, signals: signalCases,
  files: files.map(file => ({ ...file, normalizedSource: normalize(file.source) })),
  queryVector: [1, 0], windows, schema,
  nativeCases, groupedCases, previewCases, sourceCases, tokenInputs,
};
writeFileSync(output, JSON.stringify(report, (_key, value) =>
  ArrayBuffer.isView(value) ? Array.from(value as any) : value, 2) + "\n", { flag: "wx" });
console.log(`Captured ${nativeCases.length} native cases from ${Object.keys(sourceHashes).length} verified reference files.`);
