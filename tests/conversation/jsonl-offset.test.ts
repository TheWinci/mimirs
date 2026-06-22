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

  // The streaming reader processes the file in 1 MiB blocks; these exercise the
  // cross-block carry path that a small single-block file never reaches.
  test("lines and multibyte chars spanning the 1 MiB block boundary stay intact", () => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    const file = join(dir, "t.jsonl");
    // ~3 MiB of lines, each padded with multibyte chars so no line aligns to a
    // block boundary — guarantees several lines (and their UTF-8 chars) straddle
    // the 1 MiB edges.
    const lines: string[] = [];
    for (let n = 0; n < 6000; n++) {
      lines.push(JSON.stringify({ type: "user", n, pad: "café—".repeat(40) }));
    }
    writeFileSync(file, lines.join("\n") + "\n");

    const r = readJSONL(file, 0);
    expect(r.entries.length).toBe(6000);
    // n values intact and in order (no dropped/duplicated/garbled line)
    expect(r.entries.map((e) => (e as { n: number }).n)).toEqual(
      Array.from({ length: 6000 }, (_, i) => i),
    );
    // multibyte payload survives across block edges
    expect((r.entries[5999] as { pad: string }).pad).toBe("café—".repeat(40));
    expect(r.newOffset).toBe(Buffer.byteLength(lines.join("\n") + "\n"));
  });

  test("each entry's byteOffset points at the true start of its line", () => {
    dir = mkdtempSync(join(tmpdir(), "jsonl-"));
    const file = join(dir, "t.jsonl");
    const lines: string[] = [];
    for (let n = 0; n < 4000; n++) {
      lines.push(JSON.stringify({ type: "user", n, pad: "x".repeat(300) }));
    }
    const content = lines.join("\n") + "\n";
    writeFileSync(file, content);

    const r = readJSONL(file, 0);
    const bytes = Buffer.from(content, "utf-8");
    // Re-read each line from its reported byteOffset; it must parse back to the
    // same entry — proves offsets are absolute and block-boundary-correct.
    for (const e of r.entries) {
      const off = (e as { byteOffset: number }).byteOffset;
      const nl = bytes.indexOf(0x0a, off);
      const parsed = JSON.parse(bytes.subarray(off, nl).toString("utf-8"));
      expect(parsed.n).toBe((e as { n: number }).n);
    }
  });
});
