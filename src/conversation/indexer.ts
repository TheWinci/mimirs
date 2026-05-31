import { watch, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { Glob } from "bun";
import { readJSONL, parseTurns, buildTurnText, type ParsedTurn } from "./parser";
import { chunkText } from "../indexing/chunker";
import { embedBatch } from "../embeddings/embed";
import { type RagDB } from "../db";
import { type Watcher } from "../indexing/watcher";

const TAIL_DEBOUNCE_MS = 1500;

/**
 * Index all turns from a JSONL transcript file.
 * Returns the number of new turns indexed and the final byte offset.
 */
export async function indexConversation(
  jsonlPath: string,
  sessionId: string,
  db: RagDB,
  fromOffset = 0,
  startTurnIndex = 0,
  onProgress?: (msg: string) => void
): Promise<{ turnsIndexed: number; newOffset: number; totalTokens: number }> {
  const { entries, newOffset } = readJSONL(jsonlPath, fromOffset);

  if (entries.length === 0) {
    return { turnsIndexed: 0, newOffset: fromOffset, totalTokens: 0 };
  }

  const turns = parseTurns(entries, sessionId, startTurnIndex);

  let turnsIndexed = 0;
  let totalTokens = 0;

  for (const turn of turns) {
    const indexed = await indexTurn(turn, db);
    if (indexed) {
      turnsIndexed++;
      onProgress?.(`Indexed turn ${turn.turnIndex} (${turn.toolsUsed.join(", ") || "no tools"})`);
    }
    totalTokens += turn.tokenCost;
  }

  // Update session tracking
  const existingSession = db.getSession(sessionId);
  const totalTurnCount = (existingSession?.turnCount || 0) + turnsIndexed;
  const stat = statSync(jsonlPath);

  db.upsertSession(sessionId, jsonlPath, turns[0]?.timestamp || new Date().toISOString(), stat.mtimeMs, newOffset);
  db.updateSessionStats(sessionId, totalTurnCount, totalTokens, newOffset);

  return { turnsIndexed, newOffset, totalTokens };
}

/**
 * Index a single parsed turn: chunk the text, embed chunks, store in DB.
 */
async function indexTurn(turn: ParsedTurn, db: RagDB): Promise<boolean> {
  const text = buildTurnText(turn);
  if (!text.trim()) return false;

  // Chunk the turn text (use .md extension for paragraph-style splitting)
  const { chunks: textChunks } = await chunkText(text, ".md", 512, 50);

  // Embed all chunks in one batch
  const embeddings = await embedBatch(textChunks.map(c => c.text));
  const embeddedChunks = textChunks.map((chunk, i) => ({
    snippet: chunk.text,
    embedding: embeddings[i],
  }));

  // Store in DB — returns 0 if this turn was already indexed (duplicate)
  const turnId = db.insertTurn(
    turn.sessionId,
    turn.turnIndex,
    turn.timestamp,
    turn.userText,
    turn.assistantText,
    turn.toolsUsed,
    turn.filesReferenced,
    turn.tokenCost,
    turn.summary,
    embeddedChunks
  );

  return turnId !== 0;
}

/**
 * Index one transcript file from the offset persisted in its session row.
 *
 * Reading the offset from the DB on every call (rather than trusting an
 * in-memory cursor) makes repeated/overlapping calls safe: a pass that finds no
 * new bytes returns 0 and re-reads the same offset next time, so it can never
 * desync `turn_count` from stale local state. Returns the number of new turns.
 */
async function indexSessionFromStoredOffset(
  db: RagDB,
  jsonlPath: string,
  onEvent?: (msg: string) => void,
): Promise<number> {
  if (!existsSync(jsonlPath)) return 0;
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, "");
  const session = db.getSession(sessionId);
  const result = await indexConversation(
    jsonlPath,
    sessionId,
    db,
    session?.readOffset ?? 0,
    session?.turnCount ?? 0,
    onEvent,
  );
  if (result.turnsIndexed > 0) {
    onEvent?.(`Conversation ${sessionId.slice(0, 8)}: ${result.turnsIndexed} new turns indexed`);
  }
  return result.turnsIndexed;
}

/**
 * Index every transcript in a project's conversations folder from its stored
 * offset. Idempotent — already-indexed files read from their saved offset, find
 * no new bytes, and do nothing. Returns the total new turns indexed.
 */
export async function indexAllSessions(
  transcriptsDir: string,
  db: RagDB,
  onEvent?: (msg: string) => void,
): Promise<number> {
  const files: string[] = [];
  try {
    for (const file of new Glob("*.jsonl").scanSync(transcriptsDir)) {
      files.push(join(transcriptsDir, file));
    }
  } catch {
    return 0; // folder doesn't exist yet
  }

  let total = 0;
  for (const jsonlPath of files) {
    try {
      total += await indexSessionFromStoredOffset(db, jsonlPath, onEvent);
    } catch (err) {
      onEvent?.(`Conversation index error (${basename(jsonlPath)}): ${(err as Error).message}`);
    }
  }
  return total;
}

/**
 * Watch a project's conversations folder and index every transcript live.
 *
 * Replaces the old single-file tail: on startup it backfills all existing
 * sessions, then watches the folder so live sessions — and any session that
 * starts later — get indexed as they grow. This is what lets one agent's
 * findings become searchable to another in near real time.
 *
 * A single serial queue drains both the initial backfill and live file-change
 * events, so two `indexConversation` runs never overlap (overlapping runs on
 * one file could corrupt `turn_count`). The folder is flat, so a non-recursive
 * `fs.watch` is enough and stays portable across platforms.
 */
export function startConversationFolderWatch(
  transcriptsDir: string,
  db: RagDB,
  onEvent?: (msg: string) => void,
): Watcher {
  const pending = new Map<string, NodeJS.Timeout>();
  const queue = new Set<string>();
  let processing = false;

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (queue.size > 0) {
        const batch = [...queue];
        queue.clear();
        for (const jsonlPath of batch) {
          try {
            await indexSessionFromStoredOffset(db, jsonlPath, onEvent);
          } catch (err) {
            onEvent?.(`Conversation index error (${basename(jsonlPath)}): ${(err as Error).message}`);
          }
        }
      }
    } finally {
      processing = false;
    }
  }

  // Initial backfill: enqueue every existing transcript through the same queue
  // the watcher uses, so the backfill and any early live event stay serialized.
  try {
    for (const file of new Glob("*.jsonl").scanSync(transcriptsDir)) {
      queue.add(join(transcriptsDir, file));
    }
  } catch {
    // folder doesn't exist yet — the watch below will pick it up once created
  }
  drain();

  let fsWatcher: ReturnType<typeof watch> | null = null;
  try {
    fsWatcher = watch(transcriptsDir, (_event, filename) => {
      if (!filename) return;
      const name = filename.toString();
      if (!name.endsWith(".jsonl")) return;
      const jsonlPath = join(transcriptsDir, name);

      const existing = pending.get(jsonlPath);
      if (existing) clearTimeout(existing);
      pending.set(
        jsonlPath,
        setTimeout(() => {
          pending.delete(jsonlPath);
          queue.add(jsonlPath);
          drain();
        }, TAIL_DEBOUNCE_MS),
      );
    });
  } catch (err) {
    onEvent?.(`Could not watch conversations folder ${transcriptsDir}: ${(err as Error).message}`);
  }

  onEvent?.(`Watching conversations: ${transcriptsDir}`);
  return {
    close() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      fsWatcher?.close();
    },
  };
}
