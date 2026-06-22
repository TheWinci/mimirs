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

  // Stream the tail in fixed-size blocks instead of allocating
  // (stat.size - fromOffset) up front: a large/growing transcript made that a
  // whole-file Buffer + a full toString() copy + a split() array — hundreds of
  // MB of transient heap per pass. Memory here is now bounded by BLOCK plus the
  // single in-progress line, regardless of file size. (The returned `entries`
  // array still holds every parsed object — that's the API's contract and the
  // caller batches the embed step that follows.)
  const BLOCK = 1 << 20; // 1 MiB read window
  const block = Buffer.allocUnsafe(BLOCK);
  const entries: JournalEntry[] = [];

  // `carry` holds the bytes of a line that straddles a block boundary; it must
  // be an OWNED copy because `block` is reused on the next read. `lineStart` is
  // the absolute byte offset of `carry`'s first byte (or the next line's start
  // once a line is consumed). `newOffset` only advances past a complete '\n',
  // so a partially-written trailing line is never consumed (live-tail safety).
  let carry: Buffer | null = null;
  let lineStart = fromOffset;
  let readPos = fromOffset;
  let newOffset = fromOffset;

  const pushLine = (lineBytes: Buffer, startByte: number) => {
    const trimmed = lineBytes.toString("utf-8").trim();
    if (!trimmed) return;
    try {
      const entry = JSON.parse(trimmed) as JournalEntry;
      entry.byteOffset = startByte;
      entries.push(entry);
    } catch {
      // Skip malformed lines
    }
  };

  const fd = openSync(filePath, "r");
  try {
    while (readPos < stat.size) {
      const want = Math.min(BLOCK, stat.size - readPos);
      // Honor readSync's return value: a short read (or the file shrinking
      // between stat and read) must not read stale bytes past EOF.
      let filled = 0;
      while (filled < want) {
        const n = readSync(fd, block, filled, want - filled, readPos + filled);
        if (n <= 0) break; // EOF — file shrank since stat
        filled += n;
      }
      if (filled === 0) break;
      const blockBase = readPos; // absolute offset of block[0]
      readPos += filled;

      // Split this block on '\n' (0x0A). A '\n' byte never appears inside a
      // multibyte UTF-8 sequence (its other bytes are all >= 0x80), so scanning
      // raw bytes is safe even when a character straddles the block boundary —
      // such a character is carried into the next block and decoded whole.
      let scan = 0;
      while (true) {
        const nl = block.indexOf(0x0a, scan);
        if (nl === -1 || nl >= filled) break; // no more complete lines this block
        const slice = block.subarray(scan, nl);
        pushLine(carry ? Buffer.concat([carry, slice]) : slice, lineStart);
        carry = null;
        newOffset = blockBase + nl + 1; // just past this '\n'
        lineStart = newOffset;
        scan = nl + 1;
      }

      // Trailing bytes after the last '\n' belong to an in-progress line — copy
      // them out of the reused block buffer and carry to the next read.
      if (scan < filled) {
        const tail = Buffer.from(block.subarray(scan, filled));
        carry = carry ? Buffer.concat([carry, tail]) : tail;
      }
    }
  } finally {
    closeSync(fd);
  }

  // `newOffset === fromOffset` means no complete line yet — don't advance.
  return { entries, newOffset };
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
