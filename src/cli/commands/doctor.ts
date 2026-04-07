import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { platform } from "os";
import { cli } from "../../utils/log";

interface Check {
  name: string;
  run: () => string | null; // null = pass, string = error message
}

export async function doctorCommand(args: string[]) {
  const projectDir = resolve(args[1] || process.env.RAG_PROJECT_DIR || process.cwd());
  const results: { name: string; ok: boolean; detail: string }[] = [];

  const checks: Check[] = [
    {
      name: "Bun runtime",
      run: () => {
        if (typeof Bun === "undefined") return "Bun runtime not detected. local-rag requires Bun.";
        return null;
      },
    },
    {
      name: "SQLite (extension-capable)",
      run: () => {
        try {
          // Actually attempt what RagDB does: load custom SQLite and open a DB
          const { Database } = require("bun:sqlite");
          const sqliteVec = require("sqlite-vec");

          if (platform() === "darwin") {
            const macPaths = [
              "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
              "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
            ];
            const found = macPaths.find((p) => existsSync(p));
            if (!found) {
              return (
                "Homebrew SQLite not found. Apple's bundled SQLite doesn't support extensions.\n" +
                '    Fix: run "brew install sqlite" and restart your editor.'
              );
            }
            Database.setCustomSQLite(found);
          }

          // Verify extensions actually load
          const testDb = new Database(":memory:");
          sqliteVec.load(testDb);
          const row = testDb.query("SELECT vec_version() as v").get() as any;
          testDb.close();
          if (!row?.v) return "SQLite loaded but sqlite-vec didn't initialize properly.";
          return null;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (platform() === "darwin") {
            return `SQLite extension load failed: ${msg}\n    Fix: brew install sqlite`;
          }
          if (platform() === "linux") {
            return `SQLite extension load failed: ${msg}\n    Fix: install libsqlite3-dev (Debian/Ubuntu) or sqlite-devel (RHEL/Fedora)`;
          }
          return `SQLite extension load failed: ${msg}`;
        }
      },
    },
    {
      name: "Project directory",
      run: () => {
        if (!existsSync(projectDir)) return `Directory does not exist: ${projectDir}`;
        return null;
      },
    },
    {
      name: ".rag directory writable",
      run: () => {
        const ragDir = process.env.RAG_DB_DIR
          ? resolve(process.env.RAG_DB_DIR)
          : join(projectDir, ".rag");
        try {
          const { mkdirSync, writeFileSync, unlinkSync } = require("fs");
          mkdirSync(ragDir, { recursive: true });
          const probe = join(ragDir, ".doctor-probe");
          writeFileSync(probe, "ok");
          unlinkSync(probe);
          return null;
        } catch (err: unknown) {
          const detail = err instanceof Error ? (err as NodeJS.ErrnoException).code || err.message : String(err);
          return `Cannot write to ${ragDir}: ${detail}. Set RAG_DB_DIR to a writable directory.`;
        }
      },
    },
    {
      name: "Database opens",
      run: () => {
        try {
          const { RagDB } = require("../../db");
          const db = new RagDB(projectDir);
          db.close();
          return null;
        } catch (err: unknown) {
          return `Database failed to open: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: "sqlite-vec extension",
      run: () => {
        // The SQLite check above already validates sqlite-vec loading.
        // This check verifies the module can be imported independently.
        try {
          const sqliteVec = require("sqlite-vec");
          if (!sqliteVec || !sqliteVec.load) return "sqlite-vec module found but missing load function";
          return null;
        } catch (err: unknown) {
          return `sqlite-vec module not found: ${err instanceof Error ? err.message : String(err)}\n    Fix: bun install sqlite-vec`;
        }
      },
    },
    {
      name: "Embedding model",
      run: () => {
        try {
          const { getEmbedding } = require("../../embeddings/embed");
          // Just check the module loads — actual model download is async
          return null;
        } catch (err: unknown) {
          return `Embedding module failed to load: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];

  cli.log(`local-rag doctor — checking ${projectDir}\n`);

  for (const check of checks) {
    try {
      const err = check.run();
      if (err) {
        results.push({ name: check.name, ok: false, detail: err });
        cli.log(`  ✗ ${check.name}`);
        cli.log(`    ${err}\n`);
      } else {
        results.push({ name: check.name, ok: true, detail: "ok" });
        cli.log(`  ✓ ${check.name}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: check.name, ok: false, detail: msg });
      cli.log(`  ✗ ${check.name}`);
      cli.log(`    ${msg}\n`);
    }
  }

  // Check for recent server crash log
  const errorLogPath = join(projectDir, ".rag", "server-error.log");
  if (existsSync(errorLogPath)) {
    const content = readFileSync(errorLogPath, "utf8");
    cli.log(`\n--- Recent crash log (.rag/server-error.log) ---`);
    cli.log(content);
    cli.log(`--- end ---\n`);
  }

  // Check indexing status
  const statusPath = join(projectDir, ".rag", "status");
  if (existsSync(statusPath)) {
    const status = readFileSync(statusPath, "utf8");
    const firstLine = status.split("\n")[0];
    if (firstLine === "error" || firstLine === "interrupted") {
      cli.log(`\n--- Indexing status: ${firstLine} ---`);
      cli.log(status);
      cli.log(`--- end ---\n`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    cli.log(`\nAll checks passed.`);
  } else {
    cli.log(`\n${failed.length} check(s) failed. Fix the issues above and retry.`);
    process.exit(1);
  }
}
