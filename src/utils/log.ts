/**
 * Lightweight logger that writes to stderr (the MCP diagnostic channel).
 * Configurable via LOG_LEVEL env var: "debug" | "warn" | "error" | "silent"
 * Default: "warn"
 */

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
