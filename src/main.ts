#!/usr/bin/env bun

import { main } from "./cli";

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : "(no stack)";

  // stderr may not be visible in MCP clients — write to a well-known file
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

  console.error(`[mimirs] FATAL: ${msg}`);
  process.exit(1);
});
