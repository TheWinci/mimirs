import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export async function serveCommand() {
  const dir = process.env.RAG_PROJECT_DIR || process.cwd();
  process.stderr.write(`[mimirs] Starting MCP server (stdio) for ${dir}\n`);

  // Dynamic import — server/index.ts has top-level await and native deps
  // (bun:sqlite, sqlite-vec). If they fail at module load time, a static
  // import would crash the entire CLI before any error handler runs,
  // producing no status file and no server-error.log.
  let startServer: typeof import("../../server").startServer;
  try {
    ({ startServer } = await import("../../server"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : "(no stack)";
    process.stderr.write(`[mimirs] FATAL: server module failed to load: ${msg}\n`);

    // Write diagnostics so the IDE/user can see what happened
    try {
      const ragDir = join(dir, ".mimirs");
      mkdirSync(ragDir, { recursive: true });
      writeFileSync(
        join(ragDir, "server-error.log"),
        [
          `mimirs server module failed to load at ${new Date().toISOString()}`,
          ``,
          `Error: ${msg}`,
          ``,
          stack,
          ``,
          `To diagnose: bunx mimirs doctor`,
        ].join("\n")
      );
      writeFileSync(
        join(ragDir, "status"),
        [
          `error`,
          `phase: module load failed`,
          `failed: ${new Date().toISOString()}`,
          msg,
        ].join("\n")
      );
    } catch {
      // Best-effort
    }
    throw err;
  }

  await startServer();
  process.stderr.write(`[mimirs] Server ready — listening on stdin/stdout\n`);
}
