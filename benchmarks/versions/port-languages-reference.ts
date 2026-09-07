// bun benchmarks/versions/port-languages-reference.ts <pinned-v2> <new-output>
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error("expected pinned v2 directory and new output file");
const engine = resolve(root);
const contract = JSON.parse(readFileSync(new URL("port/reference.json", import.meta.url), "utf8"));
for (const [path, expected] of Object.entries(contract.reference.sourceHashes)) {
  const bytes = readFileSync(resolve(engine, path));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`modified reference: ${path}`);
  }
}
const { chunk, normalize } = await import(resolve(engine, "packages/chunk/src/index.ts"));
const inputs = JSON.parse(readFileSync(new URL("port/languages/inputs.json", import.meta.url), "utf8"));
const cases = [];
for (const input of inputs) {
  const source = normalize(input.source);
  const result = await chunk(input.path, source);
  if (result.strategy !== "ast") throw new Error(`unavailable native reference: ${input.language}`);
  const chunks: unknown[] = [];
  function visit(level: any[], parent: number | null = null) {
    for (const chunk of level) {
      const id = chunks.length;
      chunks.push({ kind: chunk.kind, name: chunk.name, parent,
        start: Buffer.byteLength(source.slice(0, chunk.startOffset)),
        end: Buffer.byteLength(source.slice(0, chunk.endOffset)) });
      visit(chunk.children, id);
    }
  }
  visit(result.chunks);
  cases.push({ ...input, chunks });
}
writeFileSync(output, JSON.stringify({ revision: contract.reference.revision, cases }, null, 2) + "\n", { flag: "wx" });
