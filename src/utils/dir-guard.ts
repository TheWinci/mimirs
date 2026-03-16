import { resolve } from "path";
import { homedir } from "os";

/**
 * Directories that should never be indexed.
 * Catches the common case where RAG_PROJECT_DIR isn't set and cwd
 * falls back to home or root — which would OOM the process.
 */
const DANGEROUS_DIRS = new Set([
  homedir(),
  "/",
  "/home",
  "/Users",
  "/tmp",
  "/var",
]);

export interface DirCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * Returns { safe: false, reason } if the directory is too broad to index.
 */
export function checkIndexDir(directory: string): DirCheckResult {
  const resolved = resolve(directory);

  if (DANGEROUS_DIRS.has(resolved)) {
    return {
      safe: false,
      reason:
        `Refusing to index "${resolved}" — this is a system-level directory that would cause excessive memory usage. ` +
        `Set RAG_PROJECT_DIR to your actual project path in your MCP server config.\n` +
        `Example: "env": { "RAG_PROJECT_DIR": "/path/to/your/project" }`,
    };
  }

  return { safe: true };
}
