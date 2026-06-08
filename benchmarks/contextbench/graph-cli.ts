/**
 * Thin graph CLI for the end-to-end agent test: file-level depends_on / dependents
 * on an indexed repo (the MCP graph tools, reachable from a plain shell).
 *   bun benchmarks/contextbench/graph-cli.ts <repoDir> <depends_on|dependents> <repo-relative-file>
 *   depends_on  = files this file imports
 *   dependents  = files that import this file
 */
import { resolve } from "path";
import { RagDB } from "../../src/db";

const [, , repoDir, mode, file] = process.argv;
if (!repoDir || !mode || !file) {
  console.error("usage: graph-cli.ts <repoDir> <depends_on|dependents> <file>");
  process.exit(1);
}
const db = new RagDB(repoDir);
const rel = (p: string) => (p.startsWith(repoDir + "/") ? p.slice(repoDir.length + 1) : p);
const f = db.getFileByPath(resolve(repoDir, file));
if (!f) { console.log(`(file not found in index: ${file})`); db.close(); process.exit(0); }
const rows = mode === "dependents" ? db.getDependedOnBy(f.id) : db.getDependsOn(f.id);
const paths = [...new Set(rows.map((r: any) => rel(r.path)))].sort();
if (!paths.length) console.log(`(no ${mode} edges for ${file})`);
else for (const p of paths) console.log(p);
db.close();
