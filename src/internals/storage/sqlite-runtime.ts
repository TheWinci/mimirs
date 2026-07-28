import { existsSync } from "node:fs";
import { platform } from "node:os";

import { Database } from "bun:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";

import { getCompiledRuntime } from "../runtime/compiled.ts";

let runtimeConfigured = false;
const extensionLoaded = new WeakSet<Database>();

/** Select an extension-capable SQLite build before the first database opens. */
export function configureSqliteRuntime(): void {
  if (runtimeConfigured) return;
  if (platform() !== "darwin") {
    runtimeConfigured = true;
    return;
  }

  const candidate = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ].find(existsSync);
  if (!candidate) {
    throw new Error(
      "sqlite-vec requires extension-capable SQLite on macOS; " +
        "install it with `brew install sqlite`",
    );
  }
  try {
    Database.setCustomSQLite(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("SQLite already loaded")) throw error;
    // Another owner may already have selected the same compatible runtime.
    // Loading sqlite-vec below is the definitive capability check.
  }
  runtimeConfigured = true;
}

/** Load vector SQL into one source-index connection. */
export function prepareSourceDatabase(database: Database): void {
  if (extensionLoaded.has(database)) return;
  try {
    const compiled = getCompiledRuntime();
    if (compiled) database.loadExtension(compiled.sqliteVec);
    else loadSqliteVec(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not load sqlite-vec: ${message}`);
  }
  extensionLoaded.add(database);
}
