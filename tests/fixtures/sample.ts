import { Database } from "bun:sqlite";

export function createConnection(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

export function runQuery(db: Database, sql: string) {
  return db.query(sql).all();
}
