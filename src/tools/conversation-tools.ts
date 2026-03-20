import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RagDB } from "../db";
import { loadConfig } from "../config";
import { embed } from "../embeddings/embed";

export function registerConversationTools(server: McpServer, getDB: (dir: string) => RagDB) {
  server.tool(
    "search_conversation",
    "Search through conversation history. Finds past decisions, discussions, and tool outputs from current or previous sessions.",
    {
      query: z.string().describe("What to search for in conversation history"),
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
        .optional()
        .default(5)
        .describe("Number of results to return (default: 5)"),
    },
    async ({ query, directory, sessionId, top }) => {
      const projectDir = directory || process.env.RAG_PROJECT_DIR || process.cwd();
      const ragDb = getDB(projectDir);
      const config = await loadConfig(projectDir);

      // Hybrid search: vector + BM25
      const queryEmb = await embed(query);
      const vecResults = ragDb.searchConversation(queryEmb, top, sessionId);

      let bm25Results: typeof vecResults = [];
      try {
        bm25Results = ragDb.textSearchConversation(query, top, sessionId);
      } catch {
        // FTS can fail on special characters
      }

      // Merge and deduplicate by turnId
      const merged = new Map<number, (typeof vecResults)[0]>();
      const hybridWeight = config.hybridWeight;

      for (const r of vecResults) {
        merged.set(r.turnId, { ...r, score: r.score * hybridWeight });
      }
      for (const r of bm25Results) {
        const existing = merged.get(r.turnId);
        if (existing) {
          existing.score += r.score * (1 - hybridWeight);
        } else {
          merged.set(r.turnId, { ...r, score: r.score * (1 - hybridWeight) });
        }
      }

      const results = [...merged.values()]
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
