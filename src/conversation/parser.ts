import { readFileSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir } from "os";
import { Glob } from "bun";

// ── JSONL entry types ──────────────────────────────────────────────

export interface JournalEntry {
  type: "user" | "assistant" | "queue-operation" | "file-history-snapshot";
  /** Absolute byte offset of this entry's line in the transcript file.
   *  Set by readJSONL; used to rewind the incremental cursor to a turn start. */
  byteOffset?: number;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  // The absolute project dir this turn ran in. Claude Code records it on every
  // content line. Used to keep path-collided projects' transcripts apart — see
  // belongsToProject() and getTranscriptsDir()'s lossy "/"→"-" encoding.
  cwd?: string;
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
  /** Byte offset of the user-text line that opened this turn (if known).
   *  The incremental cursor is held back to the LAST turn's start so a turn
   *  split across two reads is re-parsed whole instead of losing its tail. */
  startByteOffset?: number;
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

  const bytesToRead = stat.size - fromOffset;
  let buf = Buffer.alloc(bytesToRead);
  const fd = openSync(filePath, "r");
  try {
    // Honor readSync's return value: a short read (or the file shrinking
    // between stat and read) used to leave NUL-padded garbage at the tail,
    // silently masked by JSON.parse failures. Loop until EOF or buffer full.
    let filled = 0;
    while (filled < bytesToRead) {
      const n = readSync(fd, buf, filled, bytesToRead - filled, fromOffset + filled);
      if (n <= 0) break; // EOF — file shrank since stat
      filled += n;
    }
    if (filled < bytesToRead) buf = buf.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
  // Only consume up to the last newline. A trailing partial line is normal for
  // a live-tailed transcript (mid-write); advancing past it (to stat.size) would
  // leave the saved offset mid-line, so the completion bytes read back as corrupt
  // JSON next pass and that turn is lost forever. Operate on bytes so a multibyte
  // UTF-8 sequence never straddles the boundary.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) {
    // No complete line yet — don't advance.
    return { entries: [], newOffset: fromOffset };
  }
  const consumed = buf.subarray(0, lastNl + 1);
  const text = consumed.toString("utf-8");
  const entries: JournalEntry[] = [];

  // Track each line's absolute byte offset so callers can rewind the
  // incremental cursor to a turn boundary. Computed on raw bytes (not string
  // indices) so multibyte UTF-8 doesn't skew offsets.
  let lineStartByte = 0;
  for (const line of text.split("\n")) {
    const lineBytes = Buffer.byteLength(line, "utf-8");
    const trimmed = line.trim();
    if (trimmed) {
      try {
        const entry = JSON.parse(trimmed) as JournalEntry;
        entry.byteOffset = fromOffset + lineStartByte;
        entries.push(entry);
      } catch {
        // Skip malformed lines
      }
    }
    lineStartByte += lineBytes + 1; // +1 for the "\n" the split consumed
  }

  return { entries, newOffset: fromOffset + lastNl + 1 };
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
    startByteOffset?: number;
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
      startByteOffset: current.startByteOffset,
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
          startByteOffset: msg.byteOffset,
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

      // Accumulate token cost. Output tokens only: input_tokens includes the
      // FULL context on every assistant message, so summing it overcounted a
      // turn's cost by roughly the message count.
      const usage = msg.message!.usage;
      if (usage) {
        current.tokenCost += usage.output_tokens || 0;
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
 * Whether a single transcript entry belongs to `projectDir`. Entries with no
 * recorded `cwd` (meta lines: summaries, file-history snapshots) are kept — they
 * carry no project-specific content and are dropped later by turn parsing.
 */
export function belongsToProject(entry: JournalEntry, projectDir: string): boolean {
  return !entry.cwd || entry.cwd === projectDir;
}

/**
 * Classify a whole transcript file by the `cwd` its lines recorded.
 *
 * Claude Code's folder encoding ("/"→"-") is lossy, so two real project paths
 * (e.g. `a/b` and `a-b`) can share one transcript folder. This is how we tell a
 * sibling project's transcript apart from our own without trusting the folder
 * name: "own" = has lines from this project, "foreign" = has lines but all from a
 * different project, "unknown" = no cwd on any line (legacy/edge — treat as own).
 */
export function classifyTranscript(
  entries: JournalEntry[],
  projectDir: string,
): "own" | "foreign" | "unknown" {
  let own = false;
  let foreign = false;
  for (const e of entries) {
    if (!e.cwd) continue;
    if (e.cwd === projectDir) own = true;
    else foreign = true;
  }
  if (own) return "own";
  if (foreign) return "foreign";
  return "unknown";
}

/**
 * Resolve the directory holding a project's conversation transcripts.
 * Claude Code stores them in ~/.claude/projects/<encoded-path>/, where the
 * encoded path is the absolute project dir with `/` replaced by `-`.
 *
 * Fallback: Claude Code's encoding flattens more than `/` (dots and other
 * specials also become `-` in some versions), so when the exact encoding
 * doesn't exist on disk, scan for a folder that matches after flattening every
 * non-alphanumeric character — keeping dotted project paths discoverable.
 */
export function getTranscriptsDir(projectDir: string): string {
  // homedir(), not $HOME — HOME is typically unset on Windows, which made
  // the base "undefined/.claude/projects" and silently disabled indexing.
  const base = `${homedir()}/.claude/projects`;
  const encoded = projectDir.replace(/\//g, "-");
  const exact = `${base}/${encoded}`;
  try {
    if (statSync(exact).isDirectory()) return exact;
  } catch { /* not there — try the flattened form */ }

  const flattened = projectDir.replace(/[^a-zA-Z0-9-]/g, "-");
  if (flattened !== encoded) {
    const alt = `${base}/${flattened}`;
    try {
      if (statSync(alt).isDirectory()) return alt;
    } catch { /* fall through to the canonical (possibly missing) path */ }
  }
  return exact;
}

/**
 * Find all conversation JSONL files for a given project directory.
 * Claude Code stores transcripts in ~/.claude/projects/<encoded-path>/.
 */
export function discoverSessions(projectDir: string): SessionInfo[] {
  const claudeProjectDir = getTranscriptsDir(projectDir);

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
