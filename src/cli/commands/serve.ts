import { startServer } from "../../server";

export async function serveCommand() {
  const dir = process.env.RAG_PROJECT_DIR || process.cwd();
  process.stderr.write(`[local-rag] Starting MCP server (stdio) for ${dir}\n`);
  await startServer();
  process.stderr.write(`[local-rag] Server ready — listening on stdin/stdout\n`);
}
