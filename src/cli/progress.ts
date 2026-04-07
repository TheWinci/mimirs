import { cli } from "../utils/log";

/**
 * CLI progress callback for indexDirectory.
 * Transient messages (e.g. batch progress) overwrite the current line.
 * Persistent messages print on a new line.
 */
let lastWasTransient = false;

export function cliProgress(msg: string, opts?: { transient?: boolean }): void {
  if (opts?.transient) {
    const cols = process.stdout.columns || 80;
    const truncated = msg.length > cols - 1 ? msg.slice(0, cols - 4) + "..." : msg;
    process.stdout.write(`\r${truncated.padEnd(cols - 1)}`);
    lastWasTransient = true;
  } else {
    if (lastWasTransient) {
      process.stdout.write("\r" + " ".repeat((process.stdout.columns || 80) - 1) + "\r");
      lastWasTransient = false;
    }
    cli.log(msg);
  }
}
