/**
 * All project output in one place.
 *
 * - `log`  — MCP diagnostic channel (stderr, level-gated, [local-rag] prefix)
 * - `cli`  — CLI user-facing output (stdout/stderr, no prefix)
 */

// ── MCP diagnostics (stderr) ───────────────────────────────────

type Level = "debug" | "warn" | "error" | "silent";

const LEVELS: Record<Level, number> = {
  debug: 0,
  warn: 1,
  error: 2,
  silent: 3,
};

function currentLevel(): number {
  const env = (process.env.LOG_LEVEL || "warn").toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.warn;
}

// Prevent EPIPE on stderr from crashing the process when the parent disconnects
process.stderr.on("error", () => {});

function write(level: Level, prefix: string, msg: string, context?: string) {
  if (LEVELS[level] < currentLevel()) return;
  const line = context
    ? `[local-rag] ${prefix} ${msg} (${context})`
    : `[local-rag] ${prefix} ${msg}`;
  process.stderr.write(line + "\n");
}

export const log = {
  debug(msg: string, context?: string) {
    write("debug", "DEBUG", msg, context);
  },
  warn(msg: string, context?: string) {
    write("warn", "WARN", msg, context);
  },
  error(msg: string, context?: string) {
    write("error", "ERROR", msg, context);
  },
};

// ── CLI output (stdout) ────────────────────────────────────────

export const cli = {
  /** Normal output (stdout). No args = blank line. */
  log(msg: string = "") {
    console.log(msg);
  },

  /** Error output (stderr). */
  error(msg: string) {
    console.error(msg);
  },
};
