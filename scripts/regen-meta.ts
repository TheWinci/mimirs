#!/usr/bin/env bun
// Trigger phases 1-3 (discovery + categorization + bundling) and overwrite the
// _meta artifacts. Page writing is NOT triggered. Use after structural pipeline
// changes to verify _meta shape before asking the user to regenerate pages.

import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { RagDB } from "../src/db";
import { runWikiBundling } from "../src/wiki";

const projectDir = process.cwd();
const wikiDir = join(projectDir, "wiki");
const metaDir = join(wikiDir, "_meta");
mkdirSync(metaDir, { recursive: true });

const db = new RagDB(projectDir);
const result = runWikiBundling(db, projectDir, "files");

const writeJSON = (name: string, value: unknown): void => {
  const path = join(metaDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

writeJSON("_discovery.json", result.discovery);
writeJSON("_classified.json", result.classified);
writeJSON("_bundles.json", result.bundles);
writeJSON("_isolate-docs.json", result.unmatchedDocs);

console.log(`\n✅ _meta artifacts written to ${metaDir}`);
console.log(`   discovery: ${result.discovery.modules.length} modules`);
console.log(`   classified: ${result.classified.symbols.length} symbols`);
console.log(`   bundles: ${result.bundles.length} communities`);
for (const w of result.discovery.warnings) console.log(`   [discovery] ${w}`);
