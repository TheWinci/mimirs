// bun benchmarks/versions/port-relationships-reference.ts <pinned-v2> <new-output.json>
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("expected pinned v2 directory and new output file");
const engine = resolve(root);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const reference = JSON.parse(readFileSync(new URL("port/source-windows/reference.json", import.meta.url), "utf8"));
const tree = spawnSync("git", ["ls-tree", "-r", reference.revision, "--", "tests", "packages/chunk/src", "src/internals/source/relationships", "src/internals/source/relationships.ts", "src/cli/renderers/source-relationships.ts"], {cwd: repository, encoding: "utf8"});
if (tree.status !== 0) throw new Error(tree.stderr);
const hashes: Record<string, string> = {};
for (const line of tree.stdout.trim().split("\n")) {
  const [metadata, path] = line.split("\t");
  const bytes = readFileSync(resolve(engine, path!));
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== metadata!.split(" ")[2]) throw new Error(`modified reference: ${path}`);
  hashes[path!] = createHash("sha256").update(bytes).digest("hex");
}
for (const [path, hash] of Object.entries(reference.sourceHashes)) {
  if (createHash("sha256").update(readFileSync(resolve(engine, path))).digest("hex") !== hash) throw new Error(`modified reference: ${path}`);
}
const {chunk, normalize, SOURCE_FACT_EXTENSIONS, SOURCE_RELATIONSHIP_EXTENSIONS} = await import(resolve(engine, "packages/chunk/src/index.ts"));
const {connectSourceFiles, parseGoModulePath} = await import(resolve(engine, "src/internals/source/relationships.ts"));
const {renderSourceRelationships} = await import(resolve(engine, "src/cli/renderers/source-relationships.ts"));
const suiteSource = readFileSync(resolve(engine, "tests/source-relationships.test.ts"), "utf8");
const suites = [...suiteSource.match(/const SUITES = \[([\s\S]*?)\] as const/)![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
const cases = [];
for (const suite of suites) {
  const directory = `tests/fixtures/projects/${suite}`;
  for (const project of readdirSync(resolve(engine, directory), {withFileTypes: true}).filter(e => e.isDirectory()).map(e => e.name).sort()) {
    const prefix = `${directory}/${project}/`;
    const projectPaths = Object.keys(hashes).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length)).sort();
    const paths = projectPaths.filter(path => suite === "text" || (suite === "toml" || suite === "yaml" ? SOURCE_FACT_EXTENSIONS : SOURCE_RELATIONSHIP_EXTENSIONS).has(extname(path)));
    const input = [];
    const files = [];
    const sources = new Map<string, string>();
    function byteSpans(value: any, path: string): any {
      if (Array.isArray(value)) return value.map(v => byteSpans(v, path));
      if (value === null || typeof value !== "object") return value;
      const source = sources.get(path)!;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "startOffset" || key === "endOffset" ? Buffer.byteLength(source.slice(0, item as number)) : byteSpans(item, path)]));
    }
    for (const path of paths) {
      const source = normalize(readFileSync(resolve(engine, prefix, path), "utf8"));
      const result = await chunk(path, source);
      sources.set(path, source);
      input.push({path, result});
      const chunks: any[] = [];
      const visit = (level: any[], parent: number | null = null) => { for (const item of level) { const id = chunks.length; const span = byteSpans(item, path); chunks.push({kind: item.kind, name: item.name, parent, start: span.startOffset, end: span.endOffset, lineStart: item.startLine, lineEnd: item.endLine}); visit(item.children, id); } };
      visit(result.chunks);
      files.push({path, source, language: result.language, sourceSha256: hashes[prefix + path], chunks, facts: byteSpans(result.facts, path)});
    }
    const goModulePath = suite === "go" && projectPaths.includes("go.mod") ? parseGoModulePath(readFileSync(resolve(engine, prefix, "go.mod"), "utf8")) : null;
    const result = connectSourceFiles(input, {projectPaths: new Set(projectPaths), ...(suite === "go" ? {goModulePath} : {})});
    const goldenPath = `tests/goldens/relationships/${suite}/${project}.txt`;
    if (renderSourceRelationships(`${suite}/${project}`, result) !== readFileSync(resolve(engine, goldenPath), "utf8").trimEnd()) throw new Error(`relationship golden mismatch: ${suite}/${project}`);
    const relationships = {
      imports: result.imports.map((r: any) => byteSpans(r, r.fromPath)),
      reExports: result.reExports.map((r: any) => byteSpans(r, r.fromPath)),
      calls: result.calls.map((r: any) => ({...byteSpans(r, r.fromPath), to: byteSpans(r.to, r.toPath)})),
      unresolvedImports: result.unresolvedImports.map((r: any) => byteSpans(r, r.path)),
      unresolvedReExports: result.unresolvedReExports.map((r: any) => byteSpans(r, r.path)),
      unresolvedCalls: result.unresolvedCalls.map((r: any) => byteSpans(r, r.path)),
    };
    cases.push({suite, project, projectPaths, goModulePath, files, relationships, goldenSha256: hashes[goldenPath], fileHashes: Object.fromEntries(projectPaths.map(path => [path, hashes[prefix + path]]))});
  }
}
if (cases.length !== 107) throw new Error(`incomplete relationship inventory: ${cases.length}`);
writeFileSync(output, JSON.stringify({revision: reference.revision, sourceHashes: Object.fromEntries(Object.entries(hashes).filter(([path]) => !path.startsWith("tests/"))), cases}, null, 2) + "\n", {flag: "wx"});
console.log(`Captured ${cases.length} relationship projects; all archived goldens match.`);
