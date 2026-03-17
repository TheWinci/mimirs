import { readFileSync, statSync } from "fs";
import { Glob } from "bun";

// ── JSONL entry types ──────────────────────────────────────────────

export interface JournalEntry {
  type: "user" | "assistant" | "queue-operation" | "file-history-snapshot";
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  requestId?: string;
  message?: {
    role: string;
    content: ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  toolUseResult?: {
    type?: string;
    filenames?: string[];
    durationMs?: number;
    numFiles?: number;
    truncated?: boolean;
  };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] };

// ── Parsed turn ────────────────────────────────────────────────────

export interface ParsedTurn {
  turnIndex: number;
  timestamp: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  toolResults: ToolResultInfo[];
  toolsUsed: string[];
  filesReferenced: string[];
  tokenCost: number;
  summary: string; // first 200 chars of assistant text
}

export interface ToolResultInfo {
  toolName: string;
  content: string;
  durationMs?: number;
  filenames: string[];
}

// Tools whose results are redundant with the code index — skip their content
const SKIP_CONTENT_TOOLS = new Set(["Read", "Glob", "Write", "Edit", "NotebookEdit"]);

// Maximum size for "short" tool results that are always indexed
const SHORT_RESULT_THRESHOLD = 500;

// ── JSONL parsing ──────────────────────────────────────────────────

/**
 * Read a JSONL file from a byte offset. Returns parsed entries and
 * the new byte offset (for incremental reads).
 */
export function readJSONL(
  filePath: string,
  fromOffset = 0
): { entries: JournalEntry[]; newOffset: number } {
  const stat = statSync(filePath);
  if (fromOffset >= stat.size) {
    return { entries: [], newOffset: fromOffset };
  }

  const buf = readFileSync(filePath);
  const text = buf.toString("utf-8", fromOffset);
  const entries: JournalEntry[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }

  return { entries, newOffset: stat.size };
}

/**
 * Parse JSONL entries into conversation turns.
 *
 * A "turn" starts with a user text message and includes everything
 * until the next user text message. Tool use/result exchanges within
 * a turn are aggregated.
 */
export function parseTurns(
  entries: JournalEntry[],
  sessionId?: string,
  startTurnIndex = 0
): ParsedTurn[] {
  const turns: ParsedTurn[] = [];

  // Collect only user/assistant messages (skip queue-operation, file-history-snapshot)
  const messages = entries.filter(
    (e) => (e.type === "user" || e.type === "assistant") && e.message
  );

  // Track the current tool_use name by tool_use_id so we can label results
  const toolUseNames = new Map<string, string>();

  let current: {
    userText: string;
    assistantText: string;
    toolResults: ToolResultInfo[];
    toolsUsed: string[];
    filesReferenced: string[];
    tokenCost: number;
    timestamp: string;
    sessionId: string;
  } | null = null;

  function flushTurn() {
    if (!current) return;
    // Only create a turn if there's meaningful content
    if (!current.userText && !current.assistantText) return;

    const summary = current.assistantText.slice(0, 200);
    turns.push({
      turnIndex: startTurnIndex + turns.length,
      timestamp: current.timestamp,
      sessionId: current.sessionId,
      userText: current.userText,
      assistantText: current.assistantText,
      toolResults: current.toolResults,
      toolsUsed: [...new Set(current.toolsUsed)],
      filesReferenced: [...new Set(current.filesReferenced)],
      tokenCost: current.tokenCost,
      summary,
    });
  }

  for (const msg of messages) {
    const content = msg.message!.content;
    if (!Array.isArray(content)) continue;

    if (msg.type === "user") {
      // Check if this is a real user message (has text) or a tool_result
      const hasText = content.some(
        (b) => b.type === "text" && typeof (b as { text: string }).text === "string"
      );
      const hasToolResult = content.some((b) => b.type === "tool_result");

      if (hasText && !hasToolResult) {
        // New turn boundary
        flushTurn();
        const textParts = content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text);

        current = {
          userText: textParts.join("\n"),
          assistantText: "",
          toolResults: [],
          toolsUsed: [],
          filesReferenced: [],
          tokenCost: 0,
          timestamp: msg.timestamp || "",
          sessionId: sessionId || msg.sessionId || "",
        };
      } else if (hasToolResult && current) {
        // Tool result — extract content selectively
        for (const block of content) {
          if (block.type !== "tool_result") continue;

          const toolResult = block as {
            type: "tool_result";
            tool_use_id: string;
            content: string | ContentBlock[];
          };
          const toolName = toolUseNames.get(toolResult.tool_use_id) || "unknown";

          // Extract text from tool result
          let resultText = "";
          if (typeof toolResult.content === "string") {
            resultText = toolResult.content;
          } else if (Array.isArray(toolResult.content)) {
            resultText = toolResult.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
          }

          // Collect file references from toolUseResult metadata
          const filenames = msg.toolUseResult?.filenames || [];
          if (filenames.length > 0) {
            current.filesReferenced.push(...filenames);
          }

          // Selective indexing: skip content for Read/Glob/Write/Edit,
          // keep Bash/Grep output and short results
          const shouldIndex =
            !SKIP_CONTENT_TOOLS.has(toolName) ||
            resultText.length <= SHORT_RESULT_THRESHOLD;

          if (shouldIndex && resultText) {
            current.toolResults.push({
              toolName,
              content: resultText,
              durationMs: msg.toolUseResult?.durationMs,
              filenames,
            });
          }
        }
      }
    } else if (msg.type === "assistant" && current) {
      for (const block of content) {
        if (block.type === "text") {
          const textBlock = block as { type: "text"; text: string };
          if (current.assistantText) current.assistantText += "\n";
          current.assistantText += textBlock.text;
        } else if (block.type === "tool_use") {
          const toolBlock = block as { type: "tool_use"; id: string; name: string };
          current.toolsUsed.push(toolBlock.name);
          toolUseNames.set(toolBlock.id, toolBlock.name);
        }
      }

      // Accumulate token cost
      const usage = msg.message!.usage;
      if (usage) {
        current.tokenCost += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      }
    }
  }

  // Flush last turn
  flushTurn();

  return turns;
}

/**
 * Build the indexable text for a turn. Combines user text, assistant text,
 * and selected tool result content.
 */
export function buildTurnText(turn: ParsedTurn): string {
  const parts: string[] = [];

  if (turn.userText) {
    parts.push(`User: ${turn.userText}`);
  }

  if (turn.assistantText) {
    parts.push(`Assistant: ${turn.assistantText}`);
  }

  for (const result of turn.toolResults) {
    parts.push(`[${result.toolName}]: ${result.content}`);
  }

  return parts.join("\n\n");
}

// ── Session discovery ──────────────────────────────────────────────

export interface SessionInfo {
  sessionId: string;
  jsonlPath: string;
  mtime: number;
  size: number;
}

/**
 * Find all conversation JSONL files for a given project directory.
 * Claude Code stores transcripts in ~/.claude/projects/<encoded-path>/.
 */
export function discoverSessions(projectDir: string): SessionInfo[] {
  const encoded = projectDir.replace(/\//g, "-");
  const claudeProjectDir = `${process.env.HOME}/.claude/projects/${encoded}`;

  const sessions: SessionInfo[] = [];
  const glob = new Glob("*.jsonl");

  try {
    for (const file of glob.scanSync(claudeProjectDir)) {
      const fullPath = `${claudeProjectDir}/${file}`;
      const sessionId = file.replace(".jsonl", "");

      try {
        const stat = statSync(fullPath);
        sessions.push({
          sessionId,
          jsonlPath: fullPath,
          mtime: stat.mtimeMs,
          size: stat.size,
        });
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Claude project dir doesn't exist yet
  }

  // Sort by mtime descending (most recent first)
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}
