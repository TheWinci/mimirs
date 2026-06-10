import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runWikiRebuild } from "../wiki/rebuild";
import { type GetDB, resolveProject } from "./index";

const COMMANDS = [
  "shape",
  "prefetch",
  "prefetch:metadata",
  "prefetch:map",
  "prefetch:map:<path>",
  "prefetch:annotations",
  "prefetch:annotations:<path>",
  "validate-discovery",
  "discovery",
  "discovery:flow:<id>",
  "discovery:page:<slug>",
  "write",
  "write:page:<slug>",
  "validate-pages",
  "update",
  "changelog",
  "eject",
  "eject:force",
];

export function registerWikiTools(server: McpServer, getDB: GetDB) {
  server.tool(
    "wiki",
    "Run the wiki rebuild workflow. The `command` argument uses colon selectors, for example `shape`, `prefetch:map:src/server.ts`, `discovery:page:tools/search`, or `write:page:tools/search`.",
    {
      directory: z.string().optional(),
      command: z
        .string()
        .describe(`Wiki command. Supported commands: ${COMMANDS.join(", ")}. The ':' character is reserved as a selector separator.`),
    },
    async ({ directory, command }) => {
      try {
        // Inside the try so a bad directory / config-load failure returns the
        // friendly wiki error instead of a raw MCP protocol error.
        const { db, projectDir } = await resolveProject(directory, getDB);
        const text = await runWikiRebuild(
          {
            db,
            projectDir,
            // package.json import, not npm_package_version: that env var only exists
            // under `bun run` scripts, so the stamp was always "unknown" via bunx.
            version: (await import("../../package.json")).version ?? "unknown",
          },
          command,
        );
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `wiki(${command}) failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
