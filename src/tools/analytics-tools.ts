import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GetDB, resolveProject } from "./index";

export function registerAnalyticsTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "search_analytics",
    "Show search usage analytics: query counts, zero-result queries, low-relevance queries, top searched terms.",
    {
      directory: z
        .string()
        .optional()
        .describe("Project directory. Defaults to RAG_PROJECT_DIR env or cwd"),
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .default(30)
        .describe("Number of days to look back (default: 30)"),
    },
    async ({ directory, days }) => {
      const { db: ragDb } = await resolveProject(directory, getDB);
      const analytics = ragDb.getAnalytics(days);

      const lines: string[] = [
        `Search analytics (last ${days} days):`,
        `  Total queries:    ${analytics.totalQueries}`,
        `  Avg results:      ${analytics.avgResultCount.toFixed(1)}`,
        `  Avg top score:    ${analytics.avgTopScore?.toFixed(2) ?? "n/a"}`,
        `  Zero-result rate: ${analytics.totalQueries > 0 ? ((analytics.zeroResultQueries.reduce((s, q) => s + q.count, 0) / analytics.totalQueries) * 100).toFixed(0) : 0}%`,
      ];

      if (analytics.topSearchedTerms.length > 0) {
        lines.push("", "Top searches:");
        for (const t of analytics.topSearchedTerms) {
          lines.push(`  - "${t.query}" (${t.count}×)`);
        }
      }

      if (analytics.zeroResultQueries.length > 0) {
        lines.push("", "Zero-result queries (consider indexing these topics):");
        for (const q of analytics.zeroResultQueries) {
          lines.push(`  - "${q.query}" (${q.count}×)`);
        }
      }

      if (analytics.lowScoreQueries.length > 0) {
        lines.push("", "Low-relevance queries (top score < 0.3):");
        for (const q of analytics.lowScoreQueries) {
          lines.push(`  - "${q.query}" (score: ${q.topScore.toFixed(2)})`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );
}
