import { resolve, join } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";

/**
 * Directories that should never be indexed.
 * Catches the common case where RAG_PROJECT_DIR isn't set and cwd
 * falls back to home or a system root — which would OOM the process.
 */
const DANGEROUS_DIRS = new Set([
  homedir(),
  "/",
  "/home",
  "/Users",
  "/tmp",
  "/var",
  "/usr",
  "/etc",
  "/opt",
  "/bin",
  "/sbin",
  "/private",
  "/Library",
  "/System",
  "/Applications",
]);

export interface DirCheckResult {
  safe: boolean;
  reason?: string;
}

/**
 * Returns { safe: false, reason } if the directory is too broad to index.
 */
export function checkIndexDir(directory: string): DirCheckResult {
  // Expand a leading ~ (resolve() treats it as a literal "~" dir otherwise).
  let dir = directory;
  if (dir === "~" || dir.startsWith("~/")) {
    dir = dir === "~" ? homedir() : join(homedir(), dir.slice(2));
  }
  const resolved = resolve(dir);
  // Also check the symlink-resolved path so a symlink pointing at "/" can't slip
  // past — but check the un-resolved path too, since on macOS realpath turns
  // e.g. "/etc" into "/private/etc" (which would otherwise dodge the set).
  let real = resolved;
  try {
    real = realpathSync(resolved);
  } catch {
    // Directory may not exist yet — fall back to the resolved path.
  }

  if (DANGEROUS_DIRS.has(resolved) || DANGEROUS_DIRS.has(real)) {
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
