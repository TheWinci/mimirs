import { watch, statSync } from "fs";
import { readJSONL, parseTurns, buildTurnText, type ParsedTurn } from "./parser";
import { chunkText } from "../indexing/chunker";
import { embed } from "../embeddings/embed";
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
  const textChunks = await chunkText(text, ".md", 512, 50);

  // Embed each chunk
  const embeddedChunks: { snippet: string; embedding: Float32Array }[] = [];
  for (const chunk of textChunks) {
    const embedding = await embed(chunk.text);
    embeddedChunks.push({ snippet: chunk.text, embedding });
  }

  // Store in DB
  db.insertTurn(
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

  return true;
}

/**
 * Start tailing a JSONL file for live conversation indexing.
 * Watches for file changes and indexes new turns as they appear.
 */
export function startConversationTail(
  jsonlPath: string,
  sessionId: string,
  db: RagDB,
  onEvent?: (msg: string) => void
): Watcher {
  let currentOffset = 0;
  let currentTurnIndex = 0;
  let pending: NodeJS.Timeout | null = null;

  // Load existing state
  const session = db.getSession(sessionId);
  if (session) {
    currentOffset = session.readOffset;
    currentTurnIndex = session.turnCount;
  }

  async function processNewData() {
    try {
      const result = await indexConversation(
        jsonlPath,
        sessionId,
        db,
        currentOffset,
        currentTurnIndex,
        onEvent
      );

      if (result.turnsIndexed > 0) {
        currentOffset = result.newOffset;
        currentTurnIndex += result.turnsIndexed;
        onEvent?.(`Conversation: ${result.turnsIndexed} new turns indexed (total: ${currentTurnIndex})`);
      }
    } catch (err) {
      onEvent?.(`Conversation index error: ${(err as Error).message}`);
    }
  }

  const watcher = watch(jsonlPath, () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      processNewData();
    }, TAIL_DEBOUNCE_MS);
  });

  // Do initial index
  processNewData();

  onEvent?.(`Tailing conversation: ${jsonlPath}`);
  return {
    close() {
      if (pending) { clearTimeout(pending); pending = null; }
      watcher.close();
    },
  };
}
