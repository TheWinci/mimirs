import { renameSync, writeFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

/**
 * Drop-box command channel protocol (see plans/command-dropbox.md).
 *
 * A CLI process directs the index-lock-holding server by dropping a request
 * file into `.mimirs/commands/<id>.json`; the holder consumes it and writes
 * `<id>.result.json` next to it. Files land via rename-into-place, so a
 * watcher never observes partial JSON. No sockets — the same code path works
 * on win32 without a Unix-socket/named-pipe split.
 *
 * Trust boundary: `.mimirs/` is repo-local and writable only by who can
 * already write the repo and the code in it. `cmd` is a closed enum and args
 * are zod-validated per command — never shell strings.
 */

export const PROTOCOL_VERSION = 1;

/** Requests older than this found at server startup are expired, not run —
 * a command orphaned by a dead server must not fire a surprise reindex at
 * the next IDE open. */
export const REQUEST_TTL_MS = 5 * 60 * 1000;

export const commandArgSchemas = {
  /** Health check — proves the channel end-to-end. */
  "ping": z.object({}).strict(),
  /** Re-index git commit history. */
  "index.git": z.object({ since: z.string().optional() }).strict(),
  /** Re-index all conversation transcripts (runs on the server's serial
   * conversation queue — the thing that prevents turn_count corruption). */
  "index.conversation": z.object({}).strict(),
  /** Re-index project files, optionally scoped to include patterns. */
  "index.files": z.object({ patterns: z.array(z.string()).optional() }).strict(),
} as const;

export type CommandName = keyof typeof commandArgSchemas;

export const requestSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/),
  cmd: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  pid: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});

export type CommandRequest = z.infer<typeof requestSchema>;

export type ResultStatus = "ok" | "error" | "expired" | "unsupported";

export interface CommandResult {
  id: string;
  status: ResultStatus;
  detail?: string;
  stats?: Record<string, unknown>;
}

export function commandsDir(projectDir: string): string {
  return join(projectDir, ".mimirs", "commands");
}

export function requestPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

export function resultPath(dir: string, id: string): string {
  return join(dir, `${id}.result.json`);
}

/** A request file, as opposed to a result or an in-flight temp file. */
export function isRequestFile(name: string): boolean {
  return name.endsWith(".json") && !name.endsWith(".result.json");
}

/** Write JSON via temp file + rename so watchers never see partial content.
 * The temp name ends in `.tmp`, which `isRequestFile` rejects. */
export function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
