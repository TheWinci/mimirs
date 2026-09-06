/** Capture actual pinned TS model calls and final vectors; use cached assets. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const [engineArg, outputArg] = process.argv.slice(2);
if (!engineArg || !outputArg) throw new Error("usage: bun port-model-reference.ts ENGINE NEW_OUTPUT");
const engine = resolve(engineArg), output = resolve(outputArg);
if (existsSync(output)) throw new Error("output already exists");
const reference = JSON.parse(readFileSync(new URL("./port/reference.json", import.meta.url), "utf8"));
for (const [path, hash] of Object.entries(reference.reference.sourceHashes)) {
  const actual = createHash("sha256").update(readFileSync(join(engine, path))).digest("hex");
  if (actual !== hash) throw new Error(`reference source changed: ${path}`);
}
const transformers = await import(pathToFileURL(join(engine, "node_modules/@huggingface/transformers/src/transformers.js")).href);
transformers.env.allowRemoteModels = false;
const mini = await import(pathToFileURL(join(engine, "src/internals/embeddings/mini-lm.ts")).href);
const model = await mini.getMiniLmPipeline();
const tokenizer = await mini.getMiniLmTokenizer();
const original = model._call.bind(model);
let calls: string[][] = [];
model._call = async (texts: string[], options: unknown) => {
  calls.push([...texts]);
  return original(texts, options);
};
const documents = [];
for (const input of reference.tokenInputs) {
  calls = [];
  const vectors = await mini.embedPathAveragedWithMiniLm([input.text]);
  documents.push({ text: input.text, calls: calls.map(batch => batch.map(text => ({ text, ids: Array.from(tokenizer.encode(text)) }))), vector: Array.from(vectors[0]) });
}
const queries = [];
for (const text of ["recoverArchive manifest café 🧭", "Where does the archive loader recover missing manifest entries? ".repeat(90)]) {
  calls = [];
  const vectors = await mini.embedWithMiniLm([text]);
  queries.push({ text, calls: calls.map(batch => batch.map(text => ({ text, ids: Array.from(tokenizer.encode(text)) }))), vector: Array.from(vectors[0]) });
}
const runtimeEntry = createRequire(realpathSync(join(engine, "node_modules/@huggingface/transformers/package.json"))).resolve("onnxruntime-node");
const runtime = JSON.parse(readFileSync(join(dirname(runtimeEntry), "../package.json"), "utf8"));
writeFileSync(output, JSON.stringify({ runtime: { name: runtime.name, version: runtime.version, bun: Bun.version, platform: process.platform, arch: process.arch }, reference: reference.reference.revision, modelSha256: mini.MINI_LM_MODEL_SHA256, tokenizerSha256: mini.MINI_LM_TOKENIZER_SHA256, documents, queries }, null, 2) + "\n", { flag: "wx" });
