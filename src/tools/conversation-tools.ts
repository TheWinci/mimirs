import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { embed } from "../embeddings/embed";
import { rrfFuse } from "../search/hybrid";
import { log } from "../utils/log";
import {
  discoverSessions,
  readJSONL,
  parseTurns,
  buildTurnText,
  belongsToProject,
} from "../conversation/parser";
import type { ConversationTurnRow } from "../db/conversation";
import { type GetDB, resolveProject } from "./index";

// Default number of trailing turns when no turn/range is given.
const DEFAULT_TAIL = 10;
// Default total-character ceiling on returned text.
const DEFAULT_MAX_CHARS = 12000;

export function registerConversationTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "search_conversation",
    "Search through conversation history. Finds past decisions, discussions, and tool outputs from current or previous sessions.",
    {
      query: z.string().min(1).max(2000).describe("What to search for in conversation history"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      sessionId: z
        .string()
        .optional()
        .describe("Limit search to a specific session ID. Omit to search all sessions."),
      top: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(5)
        .describe("Number of results to return (default: 5)"),
    },
    async ({ query, directory, sessionId, top }) => {
      const { db: ragDb, config } = await resolveProject(directory, getDB);

      // Hybrid search: vector + BM25
      const queryEmb = await embed(query);
      const vecResults = ragDb.searchConversation(queryEmb, top, sessionId);

      let bm25Results: typeof vecResults = [];
      try {
        bm25Results = ragDb.textSearchConversation(query, top, sessionId);
      } catch (err) {
        log.debug(`Conversation FTS query failed, falling back to vector-only: ${err instanceof Error ? err.message : err}`, "conversation");
      }

      // Merge and dedup by turnId via shared rank fusion (same as chunk search).
      const results = rrfFuse(vecResults, bm25Results, config.hybridWeight, (r) => r.turnId)
        .sort((a, b) => b.score - a.score)
        .slice(0, top);

      if (results.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No conversation results found. The conversation may not be indexed yet.",
          }],
        };
      }

      const text = results
        .map((r) => {
          const tools = r.toolsUsed.length > 0 ? ` [${r.toolsUsed.join(", ")}]` : "";
          const files = r.filesReferenced.length > 0
            ? `\n  Files: ${r.filesReferenced.slice(0, 5).join(", ")}`
            : "";
          return `Turn ${r.turnIndex} (${r.timestamp})${tools}\n  ${r.snippet.slice(0, 200)}...${files}\n  → read_conversation { sessionId: "${r.sessionId}", turn: ${r.turnIndex} }`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );

  server.tool(
    "read_conversation",
    "Read the full verbatim text of past conversation turns by session + turn index. The read counterpart to search_conversation, which only returns short snippets — use it to hydrate a turn you located, or to pull a range of recent turns. Set includeToolOutput to also get tool results (re-parses the raw transcript).",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID to read from. Defaults to the most recently active session."),
      turn: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("A single turn index to read. Combine with `context` to include neighbors."),
      from: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Start of an inclusive turn-index range. Use with `to`."),
      to: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("End of an inclusive turn-index range. Use with `from`."),
      context: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Turns of padding on each side of `turn` (default: 0)."),
      maxChars: z
        .number()
        .int()
        .min(500)
        .optional()
        .default(DEFAULT_MAX_CHARS)
        .describe(`Cap on total returned characters (default: ${DEFAULT_MAX_CHARS}). Oversized turns are truncated and marked.`),
      includeToolOutput: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include full tool results by re-parsing the raw transcript. Slower; off by default."),
    },
    async ({ directory, sessionId, turn, from, to, context, maxChars, includeToolOutput }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      // Resolve the session: explicit arg, else the freshest transcript (same
      // "live session" pick as create_checkpoint).
      const sessions = discoverSessions(projectDir);
      const resolvedSession = sessionId || (sessions.length > 0 ? sessions[0].sessionId : undefined);
      if (!resolvedSession) {
        return {
          content: [{ type: "text" as const, text: "No conversation sessions found for this project." }],
        };
      }

      const turnCount = ragDb.getTurnCount(resolvedSession);
      if (turnCount === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Session ${resolvedSession} has no indexed turns yet. Run index_files or start the server to index it.`,
          }],
        };
      }

      // Resolve the inclusive [fromIdx, toIdx] window.
      let fromIdx: number;
      let toIdx: number;
      if (turn !== undefined) {
        fromIdx = turn - context;
        toIdx = turn + context;
      } else if (from !== undefined || to !== undefined) {
        fromIdx = from ?? 0;
        toIdx = to ?? from ?? turnCount - 1;
      } else {
        // No selector: tail of the conversation.
        fromIdx = turnCount - DEFAULT_TAIL;
        toIdx = turnCount - 1;
      }
      // Clamp to valid bounds.
      fromIdx = Math.max(0, Math.min(fromIdx, turnCount - 1));
      toIdx = Math.max(fromIdx, Math.min(toIdx, turnCount - 1));

      // Render each turn to a block.
      const blocks: string[] = [];
      if (includeToolOutput) {
        // Full fidelity: re-parse the raw transcript. Mirror the indexer's
        // project filter so turn indices line up with the DB.
        const session = ragDb.getSession(resolvedSession);
        const jsonlPath = session?.jsonlPath || sessions.find((s) => s.sessionId === resolvedSession)?.jsonlPath;
        if (!jsonlPath) {
          return {
            content: [{ type: "text" as const, text: `Cannot locate transcript file for session ${resolvedSession}.` }],
          };
        }
        const { entries } = readJSONL(jsonlPath, 0);
        const parsed = parseTurns(
          entries.filter((e) => belongsToProject(e, projectDir)),
          resolvedSession,
        );
        for (const t of parsed) {
          if (t.turnIndex < fromIdx || t.turnIndex > toIdx) continue;
          const tools = t.toolsUsed.length > 0 ? ` [${t.toolsUsed.join(", ")}]` : "";
          blocks.push(`### Turn ${t.turnIndex} (${t.timestamp})${tools}\n${buildTurnText(t)}`);
        }
      } else {
        const rows = ragDb.getTurnRange(resolvedSession, fromIdx, toIdx);
        for (const r of rows) {
          blocks.push(renderRow(r));
        }
      }

      if (blocks.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No turns in range ${fromIdx}–${toIdx} of session ${resolvedSession}.` }],
        };
      }

      // Enforce the character ceiling: emit whole blocks until the budget is
      // spent, truncating the block that crosses it and noting what was dropped.
      const header = `Session ${resolvedSession} — turns ${fromIdx}–${toIdx} of ${turnCount}\n`;
      let body = "";
      let used = header.length;
      let droppedBlocks = 0;
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i] + "\n\n";
        if (used + block.length <= maxChars) {
          body += block;
          used += block.length;
        } else {
          const remaining = maxChars - used;
          if (remaining > 200) {
            body += block.slice(0, remaining) + `\n…[turn truncated — raised maxChars to see the rest]\n\n`;
          }
          droppedBlocks = blocks.length - i - (remaining > 200 ? 1 : 0);
          break;
        }
      }
      const footer = droppedBlocks > 0
        ? `\n[${droppedBlocks} more turn(s) omitted — narrow the range or raise maxChars]`
        : "";

      return {
        content: [{ type: "text" as const, text: header + body.trimEnd() + footer }],
      };
    }
  );
}

/** Render a DB-stored turn (no tool output) to a readable block. */
function renderRow(r: ConversationTurnRow): string {
  const tools = r.toolsUsed.length > 0 ? ` [${r.toolsUsed.join(", ")}]` : "";
  const parts = [`### Turn ${r.turnIndex} (${r.timestamp})${tools}`];
  if (r.userText) parts.push(`User: ${r.userText}`);
  if (r.assistantText) parts.push(`Assistant: ${r.assistantText}`);
  return parts.join("\n");
}
