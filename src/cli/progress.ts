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
  const startTime = Date.now();

  return (msg: string, opts?: { transient?: boolean }) => {
    // Track current file being indexed
    if (msg.startsWith("Indexing ") && !msg.startsWith("Indexing:")) {
      currentFile = msg.slice("Indexing ".length);
      return;
    }

    // Count completed files and update progress line
    if (msg === "file:done") {
      processed++;
      if (totalFiles > 0) {
        const pct = Math.round((processed / totalFiles) * 100);
        const display = currentFile || "";
        writeTransient(`Indexing: ${processed}/${totalFiles} files (${pct}%)${display ? ` — ${display}` : ""}`);
      }
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
