// bun benchmarks/versions/port-source-windows-reference.ts <pinned-v2> <new-output.json>
// Capture TS output, never derive expected boundaries from the Rust implementation.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("expected pinned v2 directory and new output file");
const engine = resolve(root);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const revision = "122674c8bfbbc3549390743f51396c5f0e4e3537";
const tree = spawnSync("git", ["ls-tree", "-r", revision, "--",
  "src", "packages", "bun.lock", "package.json", "tests/source-windows.test.ts",
  "tests/fixtures/source-windows", "tests/goldens/source-windows"],
  { cwd: repository, encoding: "utf8" });
if (tree.status !== 0) throw new Error(tree.stderr);
const hashes: Record<string, string> = {};
for (const line of tree.stdout.trim().split("\n")) {
  const [metadata, path] = line.split("\t");
  const bytes = readFileSync(resolve(engine, path!));
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (blob !== metadata!.split(" ")[2]) throw new Error(`modified reference: ${path}`);
  hashes[path!] = createHash("sha256").update(bytes).digest("hex");
}

const { chunk, normalize, EXTENSION_MAP } = await import(resolve(engine, "packages/chunk/src/index.ts"));
const { projectSourceWindows } = await import(resolve(engine, "src/internals/source/windows.ts"));
const { renderSourceWindowTree } = await import(resolve(engine, "src/cli/renderers/source-windows.ts"));
const suite = readFileSync(resolve(engine, "tests/source-windows.test.ts"), "utf8");
const constants = new Map([...suite.matchAll(/const (\w+_CASES) = (\[[\s\S]*?\]) as const;/g)]
  .map(match => [match[1], match[2]]));
const cases = [];
const seen = new Set<string>();
for (const call of suite.matchAll(/reviewCases\("([^"]+)",\s*(\w+_CASES|\[[\s\S]*?\])\);/g)) {
  const language = call[1]!;
  const body = constants.get(call[2]!) ?? call[2]!;
  for (const entry of body.matchAll(/\["([^"]+)", (\d+)\]/g)) {
    const name = entry[1]!;
    const reviewedTarget = Number(entry[2]);
    const path = `tests/fixtures/source-windows/${language}/${name}`;
    if (seen.has(path)) throw new Error(`duplicate fixture: ${path}`);
    seen.add(path);
    const golden = `tests/goldens/source-windows/${language}/${name.split(".")[0]}.windows.txt`;
    const source = normalize(readFileSync(resolve(engine, path), "utf8"));
    const result = await chunk(path, source);
    const ids = new Map();
    const chunks: unknown[] = [];
    const byte = (offset: number) => Buffer.byteLength(source.slice(0, offset));
    const span = (value: any) => ({ start: byte(value.startOffset), end: byte(value.endOffset),
      lineStart: value.startLine, lineEnd: value.endLine });
    function visit(level: any[], parent: number | null = null) {
      for (const item of level) {
        const id = chunks.length;
        ids.set(item, id);
        chunks.push({ kind: item.kind, name: item.name, parent, ...span(item) });
        visit(item.children, id);
      }
    }
    visit(result.chunks);
    const projections = [];
    for (const target of [reviewedTarget, 80, 4000]) {
      const windows = projectSourceWindows(path, result.chunks, { targetCharacters: target });
      if (target === reviewedTarget && renderSourceWindowTree(path, windows) !==
          readFileSync(resolve(engine, golden), "utf8").trimEnd()) {
        throw new Error(`TS no longer matches reviewed golden: ${path}`);
      }
      projections.push({ target, windows: windows.map((window: any) =>
        ({ chunk: ids.get(window.sourceChunk), ...span(window) })) });
    }
    cases.push({ path, golden, sourceSha256: hashes[path], goldenSha256: hashes[golden],
      chunks, projections });
  }
}
const fixtures = Object.keys(hashes).filter(path => path.startsWith("tests/fixtures/source-windows/"));
if (fixtures.length !== seen.size || fixtures.some(path => !seen.has(path))) {
  throw new Error("review case inventory does not match archived fixtures");
}
writeFileSync(output, JSON.stringify({ revision, extensions: Object.keys(EXTENSION_MAP).sort(),
  sourceHashes: hashes, cases }, null, 2) + "\n", { flag: "wx" });
console.log(`Captured ${cases.length} fixtures at three targets; all archived goldens match.`);
