import { cli } from "../utils/log";

/**
 * CLI progress callback for indexDirectory.
 * Transient messages (e.g. batch progress) overwrite the current line.
 * Persistent messages print on a new line.
 */
let lastWasTransient = false;

function writeTransient(msg: string): void {
  const cols = process.stdout.columns || 80;
  const truncated = msg.length > cols - 1 ? msg.slice(0, cols - 4) + "..." : msg;
  process.stdout.write(`\r${truncated.padEnd(cols - 1)}`);
  lastWasTransient = true;
}

function clearTransient(): void {
  if (lastWasTransient) {
    process.stdout.write("\r" + " ".repeat((process.stdout.columns || 80) - 1) + "\r");
    lastWasTransient = false;
  }
}

export function cliProgress(msg: string, opts?: { transient?: boolean }): void {
  // file:start / file:done are bookkeeping for quiet mode; verbose already
  // shows per-file Indexing/Skipped/Indexed messages.
  if (msg.startsWith("file:")) return;

  if (opts?.transient) {
    writeTransient(msg);
  } else {
    clearTransient();
    cli.log(msg);
  }
}

/**
 * Quiet progress callback for indexDirectory.
 * Shows a single updating progress line instead of per-file output.
 * Only lets summary messages (Found, Pruned, Resolved) through as persistent lines.
 */
export function createQuietProgress(totalFiles: number): (msg: string, opts?: { transient?: boolean }) => void {
  let processed = 0;
  let currentFile = "";
  let fileChunksProcessed = 0;
  let fileChunksTotal = 0;

  function render(): void {
    if (totalFiles <= 0) return;
    const pct = Math.round((processed / totalFiles) * 100);
    const chunkPart = fileChunksTotal > 0 ? ` | ${fileChunksProcessed}/${fileChunksTotal}` : "";
    const filePart = currentFile ? ` — ${currentFile}` : "";
    writeTransient(`Indexing: ${processed}/${totalFiles} files (${pct}%)${chunkPart}${filePart}`);
  }

  return (msg: string, opts?: { transient?: boolean }) => {
    // Track current file — fired before processFile, so it covers
    // indexed, skipped, and errored files alike.
    if (msg.startsWith("file:start ")) {
      currentFile = msg.slice("file:start ".length);
      fileChunksProcessed = 0;
      fileChunksTotal = 0;
      render();
      return;
    }

    // Legacy: also pick up file name from processFile's own message
    if (msg.startsWith("Indexing ") && !msg.startsWith("Indexing:")) {
      currentFile = msg.slice("Indexing ".length);
      return;
    }

    // Track per-file chunk embedding progress: "Embedded 50/200 chunks for ..."
    const embedMatch = msg.match(/^Embedded (\d+)\/(\d+)/);
    if (embedMatch) {
      fileChunksProcessed = parseInt(embedMatch[1], 10);
      fileChunksTotal = parseInt(embedMatch[2], 10);
      render();
      return;
    }

    // Count completed files and update progress line
    if (msg === "file:done") {
      processed++;
      render();
      return;
    }

    // Let summary messages through as persistent output
    if (
      msg.startsWith("Found ") ||
      msg.startsWith("Pruned ") ||
      msg.startsWith("Resolved ")
    ) {
      clearTransient();
      cli.log(msg);
      return;
    }

    // Suppress all other messages (per-file Indexed/Skipped, batch progress, etc.)
  };
}
