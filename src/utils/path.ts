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
