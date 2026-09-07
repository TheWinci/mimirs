// bun benchmarks/versions/port-chunker-reference.ts <pinned-v2> <new-output.json>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("expected pinned v2 directory and new output file");
const engine = resolve(root);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const reference = JSON.parse(readFileSync(new URL("port/source-windows/reference.json", import.meta.url), "utf8"));
for (const [path, hash] of Object.entries(reference.sourceHashes)) {
  const bytes = readFileSync(resolve(engine, path));
  if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error(`modified reference: ${path}`);
}
const tree = spawnSync("git", ["ls-tree", "-r", reference.revision, "--", "tests"], { cwd: repository, encoding: "utf8" });
if (tree.status !== 0) throw new Error(tree.stderr);
const hashes: Record<string, string> = {};
for (const line of tree.stdout.trim().split("\n")) {
  const [metadata, path] = line.split("\t");
  const bytes = readFileSync(resolve(engine, path!));
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== metadata!.split(" ")[2]) {
    throw new Error(`modified archived test: ${path}`);
  }
  hashes[path!] = createHash("sha256").update(bytes).digest("hex");
}
const { chunk, normalize } = await import(resolve(engine, "packages/chunk/src/index.ts"));
const { renderChunkTree } = await import(resolve(engine, "src/cli/renderers/chunk-tree.ts"));
const { renderSourceFacts } = await import(resolve(engine, "src/cli/renderers/source-facts.ts"));
const suite = readFileSync(resolve(engine, "tests/chunker.test.ts"), "utf8");
const languages = new Set([...suite.match(/const LANGUAGES = \[([\s\S]*?)\] as const/)![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]));
const cases = [];
for (const path of Object.keys(hashes).sort()) {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[1] !== "fixtures" || !languages.has(parts[2])) continue;
  const language = parts[2]!;
  const stem = parts[3]!.replace(/(?:\.d)?\.[^.]+$/, "");
  const treeGolden = `tests/goldens/${language}/${stem}.tree.txt`;
  const factGolden = `tests/goldens/source-facts/${language}/${stem}.facts.txt`;
  const source = normalize(readFileSync(resolve(engine, path), "utf8"));
  const result = await chunk(path, source);
  if (renderChunkTree(path, result.chunks) !== readFileSync(resolve(engine, treeGolden), "utf8").trimEnd()) throw new Error(`tree golden mismatch: ${path}`);
  if (renderSourceFacts(path, result.facts) !== readFileSync(resolve(engine, factGolden), "utf8").trimEnd()) throw new Error(`fact golden mismatch: ${path}`);
  const byte = (offset: number) => Buffer.byteLength(source.slice(0, offset));
  const chunks: unknown[] = [];
  function visit(level: any[], parent: number | null = null) {
    for (const item of level) {
      const id = chunks.length;
      chunks.push({kind: item.kind, name: item.name, parent, start: byte(item.startOffset), end: byte(item.endOffset), lineStart: item.startLine, lineEnd: item.endLine});
      visit(item.children, id);
    }
  }
  visit(result.chunks);
  function byteSpans(value: any): any {
    if (Array.isArray(value)) return value.map(byteSpans);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "startOffset" || key === "endOffset" ? byte(item as number) : byteSpans(item)]));
  }
  cases.push({path, language, source, sourceSha256: hashes[path], treeGoldenSha256: hashes[treeGolden], factGoldenSha256: hashes[factGolden], chunks, facts: byteSpans(result.facts)});
}
if (cases.length !== 272) throw new Error(`incomplete chunker inventory: ${cases.length}`);
writeFileSync(output, JSON.stringify({revision: reference.revision, cases}, null, 2) + "\n", {flag: "wx"});
console.log(`Captured ${cases.length} complete chunk trees and fact lists; all archived goldens match.`);
