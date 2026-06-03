/**
 * Tiny phase profiler for measuring where indexing time goes.
 *
 * Off by default — `timed()` calls the wrapped function directly with zero
 * extra work unless profiling is turned on (env `MIMIRS_PROFILE=1` or a call to
 * `setProfiling(true)`). When on, it accumulates wall-clock time per label so we
 * can break a run down into named phases (parse, chunk, embed-inference, …) and
 * decide what is actually worth optimizing.
 *
 * `timed` is overloaded so a sync function stays sync (no added await/microtask)
 * and an async function returns a promise — the label only sees the elapsed time
 * either way.
 */

let enabled = process.env.MIMIRS_PROFILE === "1" || process.env.MIMIRS_PROFILE === "true";

interface PhaseEntry {
  ms: number;
  calls: number;
}

const totals = new Map<string, PhaseEntry>();

function record(label: string, ms: number): void {
  const e = totals.get(label);
  if (e) {
    e.ms += ms;
    e.calls++;
  } else {
    totals.set(label, { ms, calls: 1 });
  }
}

export function timed<T>(label: string, fn: () => Promise<T>): Promise<T>;
export function timed<T>(label: string, fn: () => T): T;
export function timed<T>(label: string, fn: () => T | Promise<T>): T | Promise<T> {
  if (!enabled) return fn();
  const start = performance.now();
  const result = fn() as T | Promise<T>;
  if (result && typeof (result as Promise<T>).then === "function") {
    return (result as Promise<T>).finally(() => record(label, performance.now() - start));
  }
  record(label, performance.now() - start);
  return result;
}

export const profiler = {
  get enabled(): boolean {
    return enabled;
  },
  setEnabled(on: boolean): void {
    enabled = on;
  },
  reset(): void {
    totals.clear();
  },
  /** Snapshot of accumulated timings, sorted by total time descending. */
  snapshot(): { label: string; ms: number; calls: number }[] {
    return [...totals.entries()]
      .map(([label, e]) => ({ label, ms: e.ms, calls: e.calls }))
      .sort((a, b) => b.ms - a.ms);
  },
  /**
   * Render the accumulated timings as an aligned table. `wallMs`, if given, is
   * the overall wall-clock of the run so the report can show how much of it the
   * timed phases account for (the remainder is untimed glue).
   */
  report(title?: string, wallMs?: number): string {
    const rows = profiler.snapshot();
    const accounted = rows.reduce((s, r) => s + r.ms, 0);
    const pctBase = wallMs ?? accounted;

    const lines: string[] = [];
    if (title) lines.push(title);
    const labelW = Math.max(5, ...rows.map((r) => r.label.length));
    const header =
      "phase".padEnd(labelW) +
      "  " + "total ms".padStart(10) +
      "  " + "%".padStart(6) +
      "  " + "calls".padStart(7) +
      "  " + "avg ms".padStart(9);
    lines.push(header);
    lines.push("-".repeat(header.length));
    for (const r of rows) {
      const pct = pctBase > 0 ? (r.ms / pctBase) * 100 : 0;
      lines.push(
        r.label.padEnd(labelW) +
          "  " + r.ms.toFixed(0).padStart(10) +
          "  " + (pct.toFixed(1) + "%").padStart(6) +
          "  " + String(r.calls).padStart(7) +
          "  " + (r.ms / r.calls).toFixed(2).padStart(9)
      );
    }
    lines.push("-".repeat(header.length));
    lines.push(`accounted`.padEnd(labelW) + "  " + accounted.toFixed(0).padStart(10));
    if (wallMs != null) {
      lines.push(`wall-clock`.padEnd(labelW) + "  " + wallMs.toFixed(0).padStart(10));
      lines.push(
        `untimed`.padEnd(labelW) + "  " + Math.max(0, wallMs - accounted).toFixed(0).padStart(10)
      );
    }
    return lines.join("\n");
  },
};

/** Convenience alias matching the plan's wording. */
export function setProfiling(on: boolean): void {
  enabled = on;
}
