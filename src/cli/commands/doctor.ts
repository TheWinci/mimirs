import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { platform } from "os";

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
      name: "SQLite (Homebrew)",
      run: () => {
        if (platform() !== "darwin") return null; // only needed on macOS
        const paths = [
          "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
          "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
        ];
        if (paths.some((p) => existsSync(p))) return null;
        return 'Homebrew SQLite not found. Fix: run "brew install sqlite" and restart your editor.';
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
        } catch (err: any) {
          return `Cannot write to ${ragDir}: ${err.code || err.message}. Set RAG_DB_DIR to a writable directory.`;
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
        } catch (err: any) {
          return `Database failed to open: ${err.message}`;
        }
      },
    },
    {
      name: "sqlite-vec extension",
      run: () => {
        try {
          const { Database } = require("bun:sqlite");
          const sqliteVec = require("sqlite-vec");
          const db = new Database(":memory:");
          sqliteVec.load(db);
          const row = db.query("SELECT vec_version() as v").get() as any;
          db.close();
          if (!row?.v) return "sqlite-vec loaded but vec_version() returned nothing";
          return null;
        } catch (err: any) {
          return `sqlite-vec failed to load: ${err.message}`;
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
        } catch (err: any) {
          return `Embedding module failed to load: ${err.message}`;
        }
      },
    },
  ];

  console.log(`local-rag doctor — checking ${projectDir}\n`);

  for (const check of checks) {
    try {
      const err = check.run();
      if (err) {
        results.push({ name: check.name, ok: false, detail: err });
        console.log(`  ✗ ${check.name}`);
        console.log(`    ${err}\n`);
      } else {
        results.push({ name: check.name, ok: true, detail: "ok" });
        console.log(`  ✓ ${check.name}`);
      }
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name: check.name, ok: false, detail: msg });
      console.log(`  ✗ ${check.name}`);
      console.log(`    ${msg}\n`);
    }
  }

  // Check for recent server crash log
  const errorLogPath = join(projectDir, ".rag", "server-error.log");
  if (existsSync(errorLogPath)) {
    const content = readFileSync(errorLogPath, "utf8");
    console.log(`\n--- Recent crash log (.rag/server-error.log) ---`);
    console.log(content);
    console.log(`--- end ---\n`);
  }

  // Check indexing status
  const statusPath = join(projectDir, ".rag", "status");
  if (existsSync(statusPath)) {
    const status = readFileSync(statusPath, "utf8");
    const firstLine = status.split("\n")[0];
    if (firstLine === "error" || firstLine === "interrupted") {
      console.log(`\n--- Indexing status: ${firstLine} ---`);
      console.log(status);
      console.log(`--- end ---\n`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log(`\nAll checks passed.`);
  } else {
    console.log(`\n${failed.length} check(s) failed. Fix the issues above and retry.`);
    process.exit(1);
  }
}
