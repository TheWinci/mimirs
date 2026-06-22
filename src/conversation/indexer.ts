import { watch, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { Glob } from "bun";
import { readJSONL, parseTurns, buildTurnText, belongsToProject, classifyTranscript, type ParsedTurn } from "./parser";
import { chunkText } from "../indexing/chunker";
import { embedBatchMerged } from "../embeddings/embed";
import { type RagDB } from "../db";
import { type Watcher } from "../indexing/watcher";

const TAIL_DEBOUNCE_MS = 1500;

// Max chunks per embed forward pass for a turn. Kept small because a turn's
// chunks can each be near the model's token limit and the batch pads to the
// longest: memory scales with batch · seq², so a large batch of long chunks
// allocates GBs at once (the OOM this caps). 16 keeps the worst case well
// under ~200 MB while staying efficient for typical small turns.
const CONV_EMBED_BATCH = 16;

/**
 * Index all turns from a JSONL transcript file.
 *
 * Incremental contract: the persisted cursor is rewound to the byte offset
 * where the LAST stored turn starts, not to the last complete JSONL line. A
 * read routinely ends mid-turn (any tool call longer than the watcher debounce
 * produces file-quiet mid-turn); advancing past that point split the turn and
 * permanently dropped its continuation. The next pass re-parses the open turn
 * whole and `upsertTurn` replaces the partial version. Unchanged turns are
 * skipped before embedding, so steady-state re-reads cost no model time.
 *
 * Returns the number of new/updated turns and the persisted byte offset.
 */
export async function indexConversation(
  jsonlPath: string,
  sessionId: string,
  db: RagDB,
  projectDir: string,
  fromOffset = 0,
  startTurnIndex?: number,
  onProgress?: (msg: string) => void
): Promise<{ turnsIndexed: number; newOffset: number; totalTokens: number }> {
  const { entries, newOffset } = readJSONL(jsonlPath, fromOffset);

  if (entries.length === 0) {
    return { turnsIndexed: 0, newOffset: fromOffset, totalTokens: 0 };
  }

  // This transcript may belong to a different project that collides into the
  // same ~/.claude/projects/ folder (Claude Code's "/"→"-" encoding is lossy).
  // If every line is from a sibling project, don't index or track it — leave the
  // offset untouched so we never claim its turns. Mixed files keep only own turns.
  if (classifyTranscript(entries, projectDir) === "foreign") {
    return { turnsIndexed: 0, newOffset: fromOffset, totalTokens: 0 };
  }

  // Resume point: when reading from a rewound cursor, the first re-parsed turn
  // IS the last stored turn — assign it the same index so upsertTurn replaces
  // it. MAX(turn_index) (not COUNT) tolerates gaps in stored indices.
  //
  // Upgrade safety: sessions indexed before the cursor fix persisted offsets
  // with OLD semantics (end of last complete line, usually past the last
  // turn's start). From such an offset the first parsed turn is genuinely NEW
  // content — assigning it maxIdx replaced the real last stored turn. The
  // rewind check therefore needs strong identity, not just userText (repeated
  // messages like "continue" collide; reproduced data loss): a genuinely
  // rewound turn re-parses with the SAME opening timestamp, and its stored
  // assistant text is a prefix of the re-parse (the continuation only appends).
  const ownEntries = entries.filter((e) => belongsToProject(e, projectDir));
  const maxIdx = db.getMaxTurnIndex(sessionId);
  let effectiveStart: number;
  if (startTurnIndex !== undefined) {
    effectiveStart = startTurnIndex;
  } else if (fromOffset === 0 || maxIdx === null) {
    effectiveStart = 0;
  } else {
    const probe = parseTurns(ownEntries, sessionId, 0);
    const stored = db.getTurnByIndex(sessionId, maxIdx);
    const first = probe[0];
    const isRewoundLastTurn =
      !!first && !!stored &&
      first.userText === stored.userText &&
      (first.timestamp && stored.timestamp
        ? first.timestamp === stored.timestamp
        : stored.assistantText === "" || first.assistantText.startsWith(stored.assistantText));
    effectiveStart = isRewoundLastTurn ? maxIdx : maxIdx + 1;
  }

  // parseTurns assigns startTurnIndex + position, so re-parse once at the
  // chosen base instead of parsing the whole tail twice.
  const turns = parseTurns(ownEntries, sessionId, effectiveStart);

  let turnsIndexed = 0;
  let totalTokens = 0;
  let lastStoredTurn: ParsedTurn | null = null;
  let failed = false;

  // Persist session cursor + stats anchored to the last STORED turn. Also
  // called when an embed throws mid-loop: stored turns already advanced past
  // the old cursor, and resuming from it would re-assign them NEW indices
  // (duplicating every turn between the stale cursor and the failure point).
  // turn_count derives from the stored index space — adding `turnsIndexed`
  // would double-count re-indexed open turns. Tokens likewise sum over STORED
  // turns; a per-pass sum clobbered the total on every tick.
  const persistCursor = (offset: number) => {
    const stat = statSync(jsonlPath);
    const totalTurnCount = (db.getMaxTurnIndex(sessionId) ?? -1) + 1;
    const sessionTokens = db.sumSessionTokens(sessionId);
    db.upsertSession(sessionId, jsonlPath, turns[0]?.timestamp || new Date().toISOString(), stat.mtimeMs, offset);
    db.updateSessionStats(sessionId, totalTurnCount, sessionTokens, offset);
  };

  try {
    for (const turn of turns) {
      const indexed = await indexTurn(turn, db);
      if (indexed !== "skipped-empty") lastStoredTurn = turn;
      if (indexed === "indexed") {
        turnsIndexed++;
        onProgress?.(`Indexed turn ${turn.turnIndex} (${turn.toolsUsed.join(", ") || "no tools"})`);
      }
      totalTokens += turn.tokenCost;
    }

    // A full from-0 re-parse is authoritative for the whole session: stale
    // stored turns above the last parsed index (gapped/drifted legacy data)
    // would survive the upserts and collide with future cursor resumes.
    if (fromOffset === 0 && turns.length > 0) {
      db.deleteTurnsAbove(sessionId, turns[turns.length - 1].turnIndex);
    }
  } catch (err) {
    failed = true;
    // Only move the cursor up to what was actually stored; with nothing
    // stored this pass, leave it untouched so the retry re-reads everything.
    if (lastStoredTurn?.startByteOffset !== undefined) {
      persistCursor(lastStoredTurn.startByteOffset);
    }
    throw err;
  }

  if (!failed) {
    const persistedOffset =
      lastStoredTurn?.startByteOffset !== undefined ? lastStoredTurn.startByteOffset : newOffset;
    persistCursor(persistedOffset);
    return { turnsIndexed, newOffset: persistedOffset, totalTokens };
  }
  // Unreachable (failure rethrows) — keeps TS happy about the return path.
  return { turnsIndexed, newOffset: fromOffset, totalTokens };
}

/**
 * Index a single parsed turn: chunk the text, embed chunks, store in DB.
 * Skips the embed + write when the stored version already has identical
 * texts — the open turn is re-parsed on every pass, and re-embedding it
 * each watcher tick would burn model time for nothing.
 */
async function indexTurn(
  turn: ParsedTurn,
  db: RagDB
): Promise<"indexed" | "unchanged" | "skipped-empty"> {
  const text = buildTurnText(turn);
  if (!text.trim()) return "skipped-empty";

  // Chunk the turn text (use .md extension for paragraph-style splitting)
  const { chunks: textChunks } = await chunkText(text, ".md", 512, 50);

  // Change detection BEFORE embedding (the expensive step): chunking is
  // deterministic, so identical chunk text means the stored version already
  // reflects this content — including tool results, which a user/assistant
  // text comparison would miss (tool-result-only continuations stayed stale).
  const stored = db.getTurnChunkText(turn.sessionId, turn.turnIndex);
  if (stored !== null && stored === textChunks.map((c) => c.text).join("\0")) {
    return "unchanged";
  }

  // Embed in bounded batches, NOT all chunks in one model() call. The model
  // pads every input in a batch to the longest one's token length, and the
  // ONNX attention tensor is O(batch · seq²): a turn with a big tool output
  // chunks into hundreds of near-512-token pieces, and a single forward pass
  // over all of them allocated multiple GB of WASM heap (measured ~2.3 GB for
  // ~200 chunks) — enough to OOM-kill the server on a memory-capped host. The
  // file index already batches its embeds (indexBatchSize) for this reason;
  // this path was the one that still passed the whole turn at once.
  const embeddings: Float32Array[] = [];
  for (let i = 0; i < textChunks.length; i += CONV_EMBED_BATCH) {
    const batch = textChunks.slice(i, i + CONV_EMBED_BATCH).map((c) => c.text);
    embeddings.push(...(await embedBatchMerged(batch)));
  }
  const embeddedChunks = textChunks.map((chunk, i) => ({
    snippet: chunk.text,
    embedding: embeddings[i],
  }));

  db.upsertTurn(
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

  return "indexed";
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
  projectDir: string,
  onEvent?: (msg: string) => void,
): Promise<number> {
  if (!existsSync(jsonlPath)) return 0;
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/, "");
  const session = db.getSession(sessionId);
  // startTurnIndex stays undefined: indexConversation derives the resume index
  // from MAX(turn_index), which tolerates gaps (turnCount/COUNT did not).
  const result = await indexConversation(
    jsonlPath,
    sessionId,
    db,
    projectDir,
    session?.readOffset ?? 0,
    undefined,
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
  projectDir: string,
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
      total += await indexSessionFromStoredOffset(db, jsonlPath, projectDir, onEvent);
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
export interface ConversationWatcher extends Watcher {
  /** Re-enqueue every transcript through the serial queue and resolve when
   * the pass drains. Returns the turns indexed while the pass ran. This is
   * how the drop-box command channel triggers a backfill without a second,
   * racing `indexConversation` path. */
  backfillAll(): Promise<number>;
}

export function startConversationFolderWatch(
  transcriptsDir: string,
  db: RagDB,
  projectDir: string,
  onEvent?: (msg: string) => void,
): ConversationWatcher {
  const pending = new Map<string, NodeJS.Timeout>();
  const queue = new Set<string>();
  let drainPromise: Promise<void> | null = null;
  let turnsIndexed = 0;

  // A running drain picks up files added mid-pass (queue re-checked every
  // iteration), so awaiting the shared promise means "drained, including my
  // items" — which is what backfillAll needs.
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
            for (const jsonlPath of batch) {
              try {
                turnsIndexed += await indexSessionFromStoredOffset(db, jsonlPath, projectDir, onEvent);
              } catch (err) {
                onEvent?.(`Conversation index error (${basename(jsonlPath)}): ${(err as Error).message}`);
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
    async backfillAll() {
      const before = turnsIndexed;
      try {
        for (const file of new Glob("*.jsonl").scanSync(transcriptsDir)) {
          queue.add(join(transcriptsDir, file));
        }
      } catch {
        // folder doesn't exist yet — nothing to backfill
      }
      await drain();
      return turnsIndexed - before;
    },
  };
}
