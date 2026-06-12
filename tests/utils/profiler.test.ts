import { describe, test, expect, afterEach } from "bun:test";
import { timed, profiler, setProfiling } from "../../src/utils/profiler";

// Module-level state — always disable and clear so nothing leaks into other
// tests that happen to run timed() code paths.
afterEach(() => {
  setProfiling(false);
  profiler.reset();
});

describe("timed", () => {
  test("disabled: passes through without recording", () => {
    expect(profiler.enabled).toBe(false);
    const out = timed("phase-a", () => 42);
    expect(out).toBe(42);
    expect(profiler.snapshot()).toEqual([]);
  });

  test("enabled: records sync calls and accumulates per label", () => {
    setProfiling(true);
    expect(profiler.enabled).toBe(true);
    expect(timed("phase-a", () => 1)).toBe(1);
    expect(timed("phase-a", () => 2)).toBe(2);

    const snap = profiler.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].label).toBe("phase-a");
    expect(snap[0].calls).toBe(2);
    expect(snap[0].ms).toBeGreaterThanOrEqual(0);
  });

  test("enabled: a sync function stays sync (no promise wrapper)", () => {
    setProfiling(true);
    const out = timed("sync-phase", () => "plain");
    expect(out).toBe("plain");
  });

  test("enabled: async function records after the promise settles", async () => {
    setProfiling(true);
    const out = timed("phase-async", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return "done";
    });
    expect(out).toBeInstanceOf(Promise);
    expect(await out).toBe("done");

    const snap = profiler.snapshot();
    expect(snap[0].label).toBe("phase-async");
    expect(snap[0].calls).toBe(1);
    expect(snap[0].ms).toBeGreaterThan(0);
  });

  test("enabled: rejected promise still records the phase", async () => {
    setProfiling(true);
    await expect(
      timed("phase-fail", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(profiler.snapshot()[0]).toMatchObject({ label: "phase-fail", calls: 1 });
  });

  test("enabled: sync throw propagates to the caller", () => {
    setProfiling(true);
    expect(() =>
      timed("phase-throw", () => {
        throw new Error("sync boom");
      })
    ).toThrow("sync boom");
  });
});

describe("profiler.snapshot", () => {
  test("sorts labels by total time descending", () => {
    setProfiling(true);
    timed("fast", () => {});
    timed("slow", () => {
      const end = performance.now() + 10;
      while (performance.now() < end) {
        /* burn ~10ms */
      }
    });
    const labels = profiler.snapshot().map((s) => s.label);
    expect(labels[0]).toBe("slow");
    expect(labels).toContain("fast");
  });

  test("reset clears accumulated totals", () => {
    setProfiling(true);
    timed("phase", () => {});
    expect(profiler.snapshot()).toHaveLength(1);
    profiler.reset();
    expect(profiler.snapshot()).toEqual([]);
  });
});

describe("profiler.report", () => {
  test("renders title, header, phase rows, and accounted total", () => {
    setProfiling(true);
    timed("parse", () => {});
    timed("embed", () => {});

    const rep = profiler.report("Indexing run");
    expect(rep).toContain("Indexing run");
    expect(rep).toContain("phase");
    expect(rep).toContain("calls");
    expect(rep).toContain("parse");
    expect(rep).toContain("embed");
    expect(rep).toContain("accounted");
    expect(rep).not.toContain("wall-clock");
  });

  test("with wallMs adds wall-clock and untimed rows", () => {
    setProfiling(true);
    timed("parse", () => {});

    const rep = profiler.report(undefined, 100);
    expect(rep).toContain("wall-clock");
    expect(rep).toContain("untimed");
    // untimed = wall - accounted, never negative
    const untimedLine = rep.split("\n").find((l) => l.startsWith("untimed"))!;
    const untimed = Number(untimedLine.trim().split(/\s+/).pop());
    expect(untimed).toBeGreaterThanOrEqual(0);
    expect(untimed).toBeLessThanOrEqual(100);
  });

  test("empty totals still renders a well-formed table", () => {
    const rep = profiler.report();
    expect(rep).toContain("phase");
    expect(rep).toContain("accounted");
  });
});
