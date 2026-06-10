/**
 * Numeric CLI flag parsing with validation.
 *
 * Raw `parseInt`/`parseFloat` on flag values silently yields `NaN` on garbage
 * input (`--days abc`), which then propagates into date math, SQL, and limits —
 * e.g. `new Date(Date.now() - NaN).toISOString()` throws an opaque
 * `RangeError`. These helpers reject bad input at the CLI boundary with a clear,
 * flag-named message instead.
 *
 * They throw `CliFlagError` rather than calling `process.exit` so they stay
 * unit-testable; the CLI dispatcher (`src/cli/index.ts`) catches it, prints the
 * message, and exits non-zero.
 */

export class CliFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliFlagError";
  }
}

interface Range {
  min?: number;
  max?: number;
}

function checkRange(n: number, name: string, opts: Range): void {
  if (opts.min !== undefined && n < opts.min) {
    throw new CliFlagError(`Invalid value for ${name}: ${n} — must be >= ${opts.min}.`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new CliFlagError(`Invalid value for ${name}: ${n} — must be <= ${opts.max}.`);
  }
}

/**
 * Parse an integer flag value. Returns `def` when the flag is absent. Uses
 * strict `Number` parsing (rejects `"12abc"`, unlike `parseInt`).
 */
export function intFlag(
  raw: string | undefined,
  name: string,
  def: number,
  opts: Range = {},
): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new CliFlagError(`Invalid value for ${name}: "${raw}" — expected an integer.`);
  }
  checkRange(n, name, opts);
  return n;
}

/**
 * Pick a positional argument that is NOT a flag. The old inline pattern only
 * rejected `--`-prefixed args, so documented short flags leaked through as
 * positionals: `mimirs index -v` indexed a junk `./-v` directory, and
 * `mimirs cleanup -y` resolved the wrong target while still mutating global
 * IDE configs. Anything starting with `-` is a flag, never a path. (A real
 * dash-prefixed directory can be addressed as `./-y`.)
 */
export function positionalArg(raw: string | undefined, def: string): string {
  if (raw && !raw.startsWith("-")) return raw;
  return def;
}

/**
 * Validate a positional query/text argument: present and not a flag token.
 * Guards `mimirs search --top 5` from semantically searching the literal
 * string "--top". Throws with the caller-supplied usage hint.
 */
export function queryArg(raw: string | undefined, usage: string): string {
  if (!raw || raw.startsWith("-")) {
    throw new CliFlagError(usage);
  }
  return raw;
}

/**
 * Parse a floating-point flag value. Returns `def` when the flag is absent.
 */
export function floatFlag(
  raw: string | undefined,
  name: string,
  def: number,
  opts: Range = {},
): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliFlagError(`Invalid value for ${name}: "${raw}" — expected a number.`);
  }
  checkRange(n, name, opts);
  return n;
}
