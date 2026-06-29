#!/usr/bin/env bun

import { main } from "./cli";

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : "(no stack)";

  // Only the long-running MCP server (`mimirs serve`) persists a crash log:
  // its stderr may not be visible in an MCP client, so a well-known file is the
  // only diagnostic. Ordinary CLI commands print a clean error to stderr —
  // writing a "server crashed" log for, say, a mistyped benchmark filename
  // misleads `doctor` (which surfaces the log) and pollutes the cwd's .mimirs/.
  if (process.argv[2] === "serve") {
    const projectDir = process.env.RAG_PROJECT_DIR || process.cwd();
    try {
      const { mkdirSync, writeFileSync } = require("fs");
      const { join } = require("path");
      const ragDir = join(projectDir, ".mimirs");
      mkdirSync(ragDir, { recursive: true });
      writeFileSync(
        join(ragDir, "server-error.log"),
        [
          `mimirs server crashed at ${new Date().toISOString()}`,
          ``,
          `Error: ${msg}`,
          ``,
          stack,
          ``,
          `To diagnose: bunx mimirs doctor`,
        ].join("\n")
      );
    } catch {
      // Best-effort — if we can't write, fall through to stderr
    }
  }

  console.error(`[mimirs] FATAL: ${msg}`);
  process.exit(1);
});
