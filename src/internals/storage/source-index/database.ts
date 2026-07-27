import { Database } from "bun:sqlite";

import {
  migrateSourceIndex,
  SOURCE_INDEX_SCHEMA_VERSION,
} from "../schema.ts";
import {
  configureSqliteRuntime,
  prepareSourceDatabase,
} from "../sqlite-runtime.ts";

export class SourceIndexSchemaMismatchError extends Error {
  constructor(
    readonly actual: number,
    readonly expected: number,
  ) {
    super(`source index schema ${actual} is incompatible with ${expected}`);
    this.name = "SourceIndexSchemaMismatchError";
  }
}

export function createSourceIndexDatabase(
  filename: string,
  readOnly: boolean,
): Database {
  configureSqliteRuntime();
  return new Database(filename, {
    create: !readOnly,
    readonly: readOnly,
    strict: true,
  });
}

export function initializeSourceIndexDatabase(
  database: Database,
  readOnly: boolean,
): void {
  prepareSourceDatabase(database);
  if (readOnly) {
    const version = database.query<{ user_version: number }, []>(
      "PRAGMA user_version",
    ).get()?.user_version ?? 0;
    if (version !== SOURCE_INDEX_SCHEMA_VERSION) {
      throw new SourceIndexSchemaMismatchError(
        version,
        SOURCE_INDEX_SCHEMA_VERSION,
      );
    }
    database.exec("PRAGMA query_only = ON");
    return;
  }

  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  migrateSourceIndex(database);
}

export function tableExists(database: Database, name: string): boolean {
  return database.query<{ present: number }, [string]>(
    `SELECT 1 AS present
     FROM sqlite_master
     WHERE name = ? AND type = 'table'`,
  ).get(name) !== null;
}
