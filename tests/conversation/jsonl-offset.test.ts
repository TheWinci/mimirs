import { describe, test, expect, afterEach } from "bun:test";
import { readJSONL } from "../../src/conversation/parser";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string | undefined;
afterEach(() => {
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = undefined; }
});

describe("readJSONL byte-offset (live-tail safety)", () => {
  test("a partially-written trailing line is not consumed and re-reads cleanly", () => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    const file = join(dir, "t.jsonl");
    const line1 = JSON.stringify({ type: "user", n: 1 }) + "\n";
    const partial = '{"type":"assistant","n":2'; // no closing brace / newline yet

    writeFileSync(file, line1 + partial);
    const first = readJSONL(file, 0);
    expect(first.entries.length).toBe(1); // only the complete line
    expect(first.newOffset).toBe(Buffer.byteLength(line1)); // NOT the full size

    // The rest of line 2 arrives.
    appendFileSync(file, '}\n');
    const second = readJSONL(file, first.newOffset);
    expect(second.entries.length).toBe(1);
    expect((second.entries[0] as { n: number }).n).toBe(2); // the completed turn, not lost
  });

  test("a read with no complete line yet does not advance the offset", () => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    const file = join(dir, "t.jsonl");
    writeFileSync(file, '{"partial":true'); // no newline at all
    const r = readJSONL(file, 0);
    expect(r.entries.length).toBe(0);
    expect(r.newOffset).toBe(0); // unchanged — try again next pass
  });

  test("a multibyte char split across the read boundary is not corrupted", () => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    const file = join(dir, "t.jsonl");
    const line = JSON.stringify({ type: "user", text: "café — déjà" }) + "\n";
    writeFileSync(file, line);
    const r = readJSONL(file, 0);
    expect((r.entries[0] as { text: string }).text).toBe("café — déjà");
  });
});
