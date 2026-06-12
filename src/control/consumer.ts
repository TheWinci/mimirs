import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, watch } from "fs";
import { basename, join } from "path";
import type { z } from "zod";
import type { Watcher } from "../indexing/watcher";
import {
  PROTOCOL_VERSION,
  REQUEST_TTL_MS,
  commandArgSchemas,
  commandsDir,
  isRequestFile,
  requestSchema,
  resultPath,
  writeAtomic,
  type CommandName,
  type CommandResult,
} from "./protocol";

export type CommandExecutors = {
  [K in CommandName]: (args: z.infer<(typeof commandArgSchemas)[K]>) => Promise<Record<string, unknown>>;
};

/**
 * Consume drop-box command requests from `.mimirs/commands/`.
 *
 * Only the index-lock holder may start this — wiring it into the server's
 * `startIndexingWork` keeps the query-only path from ever consuming, and the
 * lock-retry takeover picks it up like the rest of the indexing work.
 *
 * Requests drain through one serial control queue (same Set+flag pattern as
 * the conversation folder watcher). `index.conversation` additionally rides
 * the conversation watcher's own queue via its executor, so two
 * `indexConversation` runs never overlap.
 *
 * On startup, pending requests older than REQUEST_TTL_MS get an `expired`
 * result instead of executing; stale result files nobody collected are
 * removed so the folder can't grow without bound.
 */
export function startCommandDropbox(
  projectDir: string,
  executors: CommandExecutors,
  onEvent?: (msg: string) => void,
): Watcher {
  const dir = commandsDir(projectDir);
  mkdirSync(dir, { recursive: true });

  const queue = new Set<string>();
  const processed = new Set<string>();
  let drainPromise: Promise<void> | null = null;

  function finish(reqPath: string, result: CommandResult) {
    writeAtomic(resultPath(dir, result.id), result);
    try { unlinkSync(reqPath); } catch { /* already gone */ }
    onEvent?.(`Command ${result.id}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`);
  }

  async function handleRequest(reqPath: string) {
    if (!existsSync(reqPath)) return;
    // Fallback id from the filename so even an unparseable request can get a
    // result file — degrade loudly, not silently.
    const fileId = basename(reqPath).replace(/\.json$/, "");
    if (processed.has(fileId) || existsSync(resultPath(dir, fileId))) {
      try { unlinkSync(reqPath); } catch { /* already gone */ }
      return;
    }
    processed.add(fileId);

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(reqPath, "utf-8"));
    } catch (err) {
      finish(reqPath, { id: fileId, status: "error", detail: `Unparseable request: ${(err as Error).message}` });
      return;
    }

    const envelope = requestSchema.safeParse(parsed);
    if (!envelope.success) {
      finish(reqPath, { id: fileId, status: "error", detail: `Invalid request envelope: ${envelope.error.message}` });
      return;
    }
    const req = envelope.data;

    // Newer CLI against an older server degrades loudly, not silently.
    if (req.version > PROTOCOL_VERSION) {
      finish(reqPath, {
        id: req.id,
        status: "unsupported",
        detail: `Request version ${req.version} is newer than this server's protocol version ${PROTOCOL_VERSION} — upgrade the server.`,
      });
      return;
    }

    if (!(req.cmd in commandArgSchemas)) {
      finish(reqPath, { id: req.id, status: "unsupported", detail: `Unknown command "${req.cmd}".` });
      return;
    }
    const cmd = req.cmd as CommandName;

    const args = commandArgSchemas[cmd].safeParse(req.args);
    if (!args.success) {
      finish(reqPath, { id: req.id, status: "error", detail: `Invalid args for ${cmd}: ${args.error.message}` });
      return;
    }

    onEvent?.(`Command ${req.id}: running ${cmd}`);
    try {
      const stats = await executors[cmd](args.data as never);
      finish(reqPath, { id: req.id, status: "ok", stats });
    } catch (err) {
      finish(reqPath, { id: req.id, status: "error", detail: (err as Error).message });
    }
  }

  // Serial control queue. A running drain picks up files added mid-pass, and
  // callers awaiting the shared promise resolve only when fully drained.
  function drain(): Promise<void> {
    if (!drainPromise) {
      drainPromise = (async () => {
        // Yield first: with an empty queue this body would otherwise complete
        // synchronously, running the finally BEFORE the assignment to
        // drainPromise lands — leaving a forever-resolved promise that makes
        // every future drain() a no-op.
        await Promise.resolve();
        try {
          while (queue.size > 0) {
            const batch = [...queue];
            queue.clear();
            for (const reqPath of batch) {
              try {
                await handleRequest(reqPath);
              } catch (err) {
                onEvent?.(`Command error (${basename(reqPath)}): ${(err as Error).message}`);
              }
            }
          }
        } finally {
          drainPromise = null;
          // An add can slip in between the final queue check and this reset —
          // it would otherwise sit unprocessed until the next event.
          if (queue.size > 0) drain();
        }
      })();
    }
    return drainPromise;
  }

  // Startup drain: expire orphans, clean uncollected results, run the rest.
  try {
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith(".result.json") || name.endsWith(".tmp")) {
        // Results are collected by the producer within its poll interval; one
        // older than the TTL has no reader left. Temp files are abandoned writes.
        try {
          if (now - statSync(path).mtimeMs > REQUEST_TTL_MS) unlinkSync(path);
        } catch { /* already gone */ }
        continue;
      }
      if (!isRequestFile(name)) continue;
      try {
        if (now - statSync(path).mtimeMs > REQUEST_TTL_MS) {
          finish(path, {
            id: name.replace(/\.json$/, ""),
            status: "expired",
            detail: `Request was older than ${Math.round(REQUEST_TTL_MS / 60000)} minutes at server startup.`,
          });
          continue;
        }
      } catch { continue; /* vanished under us */ }
      queue.add(path);
    }
  } catch { /* dir vanished — watch below recreates interest */ }
  drain();

  // Enqueue every pending request file. The watch event's filename is
  // unusable: macOS reports a rename-into-place under the SOURCE name
  // (`<id>.json.tmp`) and never fires for the target, so any trigger just
  // rescans — the folder holds at most a handful of files, and handleRequest
  // dedups via the processed set.
  function enqueuePending() {
    let found = false;
    try {
      for (const name of readdirSync(dir)) {
        if (!isRequestFile(name)) continue;
        queue.add(join(dir, name));
        found = true;
      }
    } catch {
      return; // dir vanished mid-scan
    }
    if (found) drain();
  }

  let fsWatcher: ReturnType<typeof watch> | null = null;
  try {
    // Folder is flat; non-recursive fs.watch is enough and portable (win32 ok).
    fsWatcher = watch(dir, () => enqueuePending());
  } catch (err) {
    onEvent?.(`Could not watch commands folder ${dir}: ${(err as Error).message}`);
  }

  // fs.watch is best-effort: a request landing between the startup drain and
  // the watcher becoming active gets no event (macOS FSEvents activates
  // asynchronously), and platforms may drop events under load. Rescan once
  // now to close the startup gap, then poll slowly as a delivery guarantee —
  // the producer polls for its result anyway, so a late pickup only adds
  // seconds of latency in the rare lost-event case.
  enqueuePending();
  const rescanTimer = setInterval(enqueuePending, 2_000);
  if (typeof rescanTimer.unref === "function") rescanTimer.unref();

  onEvent?.(`Consuming commands: ${dir}`);
  return {
    close() {
      clearInterval(rescanTimer);
      fsWatcher?.close();
    },
  };
}
