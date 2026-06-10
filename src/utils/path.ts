/**
 * Normalize a filesystem path to use forward-slash separators.
 *
 * Why: on Windows, `resolve()`, `relative()`, `dirname()`, and `readdir()`
 * all return native `\`-separated paths. Mimirs stores file paths as a
 * canonical form in SQLite and many call sites split/match on `/`. We
 * normalize at every storage and computation boundary so downstream code
 * can assume `/` regardless of platform.
 *
 * Idempotent — safe to call on already-normalized paths.
 */
export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

import { isAbsolute, relative } from "path";

/**
 * Canonicalize a user/agent-supplied file path to the project-relative,
 * forward-slash form mimirs stores and matches on.
 *
 * Tool handlers MUST pass paths through this at the boundary: tools display
 * absolute paths in results, so agents naturally feed absolute paths back in
 * — stored verbatim, those never match a relative lookup and the data
 * silently disappears (annotations were the proven case). Also strips a
 * leading "./".
 */
export function toProjectRelative(projectDir: string, p: string): string {
  let out = normalizePath(p.trim());
  const proj = normalizePath(projectDir).replace(/\/+$/, "");
  if (isAbsolute(out)) {
    const rel = normalizePath(relative(proj, out));
    // Outside the project (or a different drive): keep the absolute path
    // rather than a ../../ chain that matches nothing either way.
    if (!rel.startsWith("..") && !isAbsolute(rel)) out = rel;
  }
  if (out.startsWith("./")) out = out.slice(2);
  return out;
}
