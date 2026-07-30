import { describe, expect, test } from "bun:test";

import {
  IndexProgressRenderer,
  type IndexProgressStream,
} from "../src/cli/renderers/index-progress.ts";

function stream(
  isTTY: boolean,
): IndexProgressStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    isTTY,
    columns: 64,
    writes,
    write: (value) => writes.push(value),
  };
}

describe("index progress renderer", () => {
  test("renders an in-place two-phase progress bar for terminals", () => {
    const output = stream(true);
    let now = 0;
    const renderer = new IndexProgressRenderer(output, {
      minimumRenderIntervalMs: 50,
      now: () => now,
    });

    renderer.start();
    renderer.indexing({ completed: 0, total: 20, path: null });
    now = 10;
    renderer.indexing({
      completed: 1,
      total: 20,
      path: "src/a-very-long-directory/example.ts",
    });
    now = 60;
    renderer.indexing({
      completed: 10,
      total: 20,
      path: "src/example.ts",
    });
    renderer.embedding({ completed: 0, total: 10 });
    renderer.embedding({ completed: 10, total: 10 });
    renderer.finish();

    expect(output.writes[0]).toContain("Scanning source files");
    expect(output.writes.some((value) =>
      value.includes("Indexing [") && value.includes("10/20 50%")
    )).toBe(true);
    expect(output.writes.some((value) =>
      value.includes("Embedding [") && value.includes("10/10 100%")
    )).toBe(true);
    expect(output.writes.some((value) =>
      value.includes("first batch")
    )).toBe(true);
    expect(output.writes.at(-1)).toBe("\r\u001b[2K");
    expect(output.writes).toHaveLength(6);
  });

  test("emits only phase changes, ten-percent milestones, and completion when redirected", () => {
    const output = stream(false);
    const renderer = new IndexProgressRenderer(output);

    renderer.start();
    renderer.indexing({ completed: 0, total: 100, path: null });
    renderer.indexing({ completed: 1, total: 100, path: "src/one.ts" });
    renderer.indexing({ completed: 9, total: 100, path: "src/nine.ts" });
    renderer.indexing({ completed: 10, total: 100, path: "src/ten.ts" });
    renderer.indexing({ completed: 11, total: 100, path: "src/eleven.ts" });
    renderer.indexing({ completed: 100, total: 100, path: "src/final.ts" });
    renderer.embedding({ completed: 80, total: 100 });
    renderer.embedding({ completed: 100, total: 100 });
    renderer.finish();

    expect(output.writes).toEqual([
      "Scanning source files…\n",
      "Indexing: 0/100 (0%)\n",
      "Indexing: 10/100 (10%) src/ten.ts\n",
      "Indexing: 100/100 (100%) src/final.ts\n",
      "Embedding: 80/100 (80%)\n",
      "Embedding: 100/100 (100%)\n",
    ]);
  });
});
