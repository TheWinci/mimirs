import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { embed } from "../embeddings/embed";
import { rrfFuse } from "../search/hybrid";
import { log } from "../utils/log";
import { type GetDB, resolveProject } from "./index";

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
          return `Turn ${r.turnIndex} (${r.timestamp})${tools}\n  ${r.snippet.slice(0, 200)}...${files}`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
