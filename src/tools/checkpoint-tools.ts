import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { embed } from "../embeddings/embed";
import { discoverSessions } from "../conversation/parser";
import { type GetDB, resolveProject } from "./index";

export function registerCheckpointTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "create_checkpoint",
    "Save a checkpoint so future sessions know what was done and why. REQUIRED: call this as your final step after completing any user-requested task, before responding to the user. Also call when hitting a blocker or changing direction mid-task.",
    {
      type: z
        .enum(["decision", "milestone", "blocker", "direction_change", "handoff"])
        .describe("Type of checkpoint"),
      title: z.string().min(1).max(200).describe("Short label, e.g. 'Chose JWT over session cookies'"),
      summary: z
        .string()
        .min(1)
        .max(2000)
        .describe("2-3 sentence description of what happened and why"),
      filesInvolved: z
        .array(z.string())
        .optional()
        .describe("Files relevant to this checkpoint"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Freeform tags for filtering"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ type, title, summary, filesInvolved, tags, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      // Get current session's latest turn index
      const sessions = discoverSessions(projectDir);
      const sessionId = sessions.length > 0 ? sessions[0].sessionId : "unknown";

      // Determine turn index from DB
      const turnCount = ragDb.getTurnCount(sessionId);
      const turnIndex = Math.max(0, turnCount - 1);

      // Embed title + summary for semantic search
      const embText = `${title}. ${summary}`;
      const embedding = await embed(embText);

      const id = ragDb.createCheckpoint(
        sessionId,
        turnIndex,
        new Date().toISOString(),
        type,
        title,
        summary,
        filesInvolved ?? [],
        tags ?? [],
        embedding
      );

      const hints: string[] = [];
      if (filesInvolved && filesInvolved.length > 0) {
        hints.push(
          `If you noticed any caveats, known issues, or "don't touch" conditions in the files above, call annotate() now to attach them.`
        );
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `Checkpoint #${id} created: [${type}] ${title}`,
            ...hints,
          ].join("\n\n"),
        }],
      };
    }
  );

  server.tool(
    "list_checkpoints",
    "List conversation checkpoints, most recent first. Cross-session by default.",
    {
      sessionId: z.string().optional().describe("Limit to a specific session ID"),
      type: z
        .enum(["decision", "milestone", "blocker", "direction_change", "handoff"])
        .optional()
        .describe("Filter by checkpoint type"),
      limit: z.number().int().min(1).optional().default(20).describe("Max results (default: 20)"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ sessionId, type, limit, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const checkpoints = ragDb.listCheckpoints(sessionId, type, limit);

      if (checkpoints.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No checkpoints found." }],
        };
      }

      const text = checkpoints
        .map((cp) => {
          const files = cp.filesInvolved.length > 0
            ? `\n  Files: ${cp.filesInvolved.join(", ")}`
            : "";
          const tagStr = cp.tags.length > 0 ? ` [${cp.tags.join(", ")}]` : "";
          return `#${cp.id} [${cp.type}] ${cp.title}${tagStr}\n  ${cp.timestamp} (turn ${cp.turnIndex})\n  ${cp.summary}${files}`;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );

  server.tool(
    "search_checkpoints",
    "Semantic search over checkpoint titles and summaries.",
    {
      query: z.string().min(1).max(2000).describe("What to search for in checkpoints"),
      type: z
        .enum(["decision", "milestone", "blocker", "direction_change", "handoff"])
        .optional()
        .describe("Filter by checkpoint type"),
      limit: z.number().int().min(1).optional().default(5).describe("Max results (default: 5)"),
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
    },
    async ({ query, type, limit, directory }) => {
      const { projectDir, db: ragDb } = await resolveProject(directory, getDB);

      const queryEmb = await embed(query);
      const results = ragDb.searchCheckpoints(queryEmb, limit, type);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching checkpoints found." }],
        };
      }

      const text = results
        .map((cp) => {
          const files = cp.filesInvolved.length > 0
            ? `\n  Files: ${cp.filesInvolved.join(", ")}`
            : "";
          return `${cp.score.toFixed(4)}  #${cp.id} [${cp.type}] ${cp.title}\n  ${cp.summary}${files}`;
        })
        .join("\n\n");

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
