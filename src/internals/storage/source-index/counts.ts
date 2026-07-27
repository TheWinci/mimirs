import type { Database } from "bun:sqlite";

import type { CountRow } from "../rows.ts";

export class IndexCounts {
  constructor(private readonly database: Database) {}

  chunks(): number {
    return this.count("source_chunks");
  }

  windows(): number {
    return this.count("source_windows");
  }

  private count(table: "source_chunks" | "source_windows"): number {
    return this.database.query<CountRow, []>(
      `SELECT count(*) AS count FROM ${table}`,
    ).get()?.count ?? 0;
  }
}
