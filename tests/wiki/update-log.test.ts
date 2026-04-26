import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInitLog,
  appendQueueStub,
  appendNarrative,
  writeSnapshot,
  readSnapshot,
  deleteSnapshot,
  snapshotPath,
} from "../../src/wiki/update-log";
import { diffPage } from "../../src/wiki/diff-page";
import type { PageManifest, PreRegenSnapshot } from "../../src/wiki/types";

function tmpWiki(): string {
  return mkdtempSync(join(tmpdir(), "wiki-log-"));
}

function manifest(): PageManifest {
  return {
    version: 3,
    generatedAt: "2026-01-01T00:00:00Z",
    lastGitRef: "abc",
    pageCount: 2,
    pages: {
      "wiki/architecture.md": {
        kind: "architecture",
        slug: "architecture",
        title: "Architecture",
        purpose: "",
        sections: [],
        depth: "full",
        memberFiles: [],
        relatedPages: [],
        order: 0,
      },
      "wiki/communities/db.md": {
        kind: "community",
        slug: "db",
        title: "Database",
        purpose: "",
        sections: [],
        depth: "standard",
        memberFiles: ["src/db.ts"],
        relatedPages: [],
        order: 1,
      },
    },
    warnings: [],
  };
}

describe("appendInitLog", () => {
  test("writes header + breakdown", () => {
    const dir = tmpWiki();
    appendInitLog(dir, "abc1234", manifest());
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    expect(log).toContain("# Wiki Update Log");
    expect(log).toContain("Full initialization");
    expect(log).toContain("`abc1234`");
    expect(log).toContain("1 architecture, 1 community");
  });
});

describe("header migration", () => {
  test("rewrites legacy 'Newest entries at the bottom' header on next append", () => {
    const dir = tmpWiki();
    const path = join(dir, "_update-log.md");
    const legacy =
      `# Wiki Update Log\n\n` +
      `Append-only log of wiki generation and incremental updates. ` +
      `Newest entries at the bottom. Emitted deterministically from the ` +
      `staleness report — not LLM-generated.\n\n` +
      `## 2026-01-01 00:00 UTC — Old entry\n\n` +
      `Body of old entry.\n`;
    writeFileSync(path, legacy);
    appendQueueStub(dir, "abc", "def", 1, 1, 0, 0, 1);
    const log = readFileSync(path, "utf-8");
    expect(log).not.toContain("Newest entries at the bottom");
    expect(log).toContain("Changelog-style: newest entries at the top");
    expect(log).toContain("Old entry");
  });

  test("no-op on already-migrated header", () => {
    const dir = tmpWiki();
    appendInitLog(dir, "abc", manifest());
    const before = readFileSync(join(dir, "_update-log.md"), "utf-8");
    appendQueueStub(dir, "abc", "def", 1, 1, 0, 0, 1);
    const after = readFileSync(join(dir, "_update-log.md"), "utf-8");
    // Header line count and text unchanged.
    expect(after).toContain("Changelog-style: newest entries at the top");
    expect(after.split("Changelog-style").length).toBe(2);
    expect(before).toContain("Changelog-style: newest entries at the top");
  });
});

describe("entry order", () => {
  test("newest entry sits directly after header, oldest at bottom", () => {
    const dir = tmpWiki();
    appendInitLog(dir, "first", manifest());
    appendQueueStub(dir, "first", "second", 1, 1, 0, 0, 1);
    appendQueueStub(dir, "second", "third", 1, 1, 0, 0, 1);
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    const idxFirst = log.indexOf("Full initialization (`first`)");
    const idxSecond = log.indexOf("`first` → `second`");
    const idxThird = log.indexOf("`second` → `third`");
    // Newest (third) above second above first.
    expect(idxThird).toBeGreaterThan(0);
    expect(idxThird).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxFirst);
  });
});

describe("appendQueueStub", () => {
  test("emits stable marker for the regen newRef", () => {
    const dir = tmpWiki();
    appendQueueStub(dir, "abc", "def", 3, 2, 1, 0, 4);
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    expect(log).toContain("Incremental regen queued (`abc` → `def`)");
    expect(log).toContain("<!-- regen:def -->");
    expect(log).toContain("3 files changed across 4 commits");
    expect(log).toContain("2 regenerated, 1 added, 0 removed");
    expect(log).toContain("narrative pending");
  });

  test("no-invalidation case skips pending-narrative line", () => {
    const dir = tmpWiki();
    appendQueueStub(dir, "abc", "def", 1, 0, 0, 0, 1);
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    expect(log).toContain("No wiki pages invalidated");
    expect(log).not.toContain("narrative pending");
  });
});

describe("appendNarrative", () => {
  test("inserts under the matching marker and strips pending sentinel", () => {
    const dir = tmpWiki();
    appendQueueStub(dir, "abc", "def", 1, 1, 0, 0, 1);
    const result = appendNarrative(dir, "def", "- `wiki/db.md` — added FTS triggers section.");
    expect(result.mode).toBe("inserted");
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    expect(log).toContain("### What changed in this regen");
    expect(log).toContain("FTS triggers section");
    // Pending sentinel from the queue stub must be gone.
    expect(log).not.toContain("Per-page narrative pending");
    // Narrative comes after marker.
    const markerIdx = log.indexOf("<!-- regen:def -->");
    const narrativeIdx = log.indexOf("### What changed");
    expect(narrativeIdx).toBeGreaterThan(markerIdx);
  });

  test("narrative lands AFTER the counts line, not above it", () => {
    const dir = tmpWiki();
    appendQueueStub(dir, "abc", "def", 5, 3, 1, 0, 4);
    appendNarrative(dir, "def", "- bullet body");
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    const countsIdx = log.indexOf("3 regenerated, 1 added, 0 removed");
    const narrativeIdx = log.indexOf("### What changed");
    expect(countsIdx).toBeGreaterThan(0);
    expect(narrativeIdx).toBeGreaterThan(countsIdx);
  });

  test("narrative does not bleed into the next entry", () => {
    const dir = tmpWiki();
    appendQueueStub(dir, "abc", "def", 1, 1, 0, 0, 1);
    appendQueueStub(dir, "def", "ghi", 1, 1, 0, 0, 1);
    appendNarrative(dir, "def", "- middle entry narrative");
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    // Newest-first ordering: ghi block, def block (with narrative), abc init.
    const ghiIdx = log.indexOf("`def` → `ghi`");
    const narrativeIdx = log.indexOf("middle entry narrative");
    const defStubIdx = log.indexOf("`abc` → `def`");
    expect(narrativeIdx).toBeGreaterThan(defStubIdx);
    // Narrative must NOT have leaked above the ghi (newer) entry.
    expect(narrativeIdx).toBeGreaterThan(ghiIdx);
  });

  test("falls back to standalone append when marker missing", () => {
    const dir = tmpWiki();
    const result = appendNarrative(dir, "ghost", "- one bullet");
    expect(result.mode).toBe("appended");
    const log = readFileSync(join(dir, "_update-log.md"), "utf-8");
    expect(log).toContain("orphan, `ghost`");
    expect(log).toContain("one bullet");
  });
});

describe("snapshot IO", () => {
  test("write, read, delete round-trip", () => {
    const dir = tmpWiki();
    const snap: PreRegenSnapshot = {
      version: 1,
      sinceRef: "abc",
      newRef: "def",
      capturedAt: "2026-01-01T00:00:00Z",
      commits: [{ hash: "abc", message: "feat: x" }],
      removed: [],
      pages: {
        "wiki/db.md": {
          title: "DB",
          kind: "community",
          depth: "standard",
          triggers: ["src/db.ts"],
          oldContent: "# DB\n\nold body\n",
        },
      },
    };
    writeSnapshot(dir, snap);
    expect(existsSync(snapshotPath(dir))).toBe(true);
    const back = readSnapshot(dir);
    expect(back?.newRef).toBe("def");
    expect(back?.pages["wiki/db.md"].oldContent).toContain("old body");
    deleteSnapshot(dir);
    expect(existsSync(snapshotPath(dir))).toBe(false);
  });

  test("readSnapshot returns null on missing/corrupt file", () => {
    const dir = tmpWiki();
    expect(readSnapshot(dir)).toBeNull();
    mkdirSync(join(dir, "_meta"), { recursive: true });
    writeFileSync(snapshotPath(dir), "{not json");
    expect(readSnapshot(dir)).toBeNull();
  });
});

describe("diffPage", () => {
  const oldBody = `# Database

## Overview

The DB exposes \`src/db.ts\` and \`src/db/files.ts\`.

## Tunables

- \`DEFAULT_LIMIT = 50\`

\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`
`;

  const newBody = `# Database

## Overview

The DB exposes \`src/db.ts\`, \`src/db/files.ts\`, and \`src/db/graph.ts\` for graph queries that handle batched edge writes and atomic JSON updates across the indexing pipeline. Significant rewrite of the overview to reflect new exports and lifecycle.

## Tunables

- \`DEFAULT_LIMIT = 100\`
- \`BATCH_SIZE = 32\`

## FTS triggers

Brand new section.

\`\`\`mermaid
sequenceDiagram
  participant A
  participant B
  A->>B: call
\`\`\`
`;

  test("flags added sections, citations, mermaid type change", () => {
    const d = diffPage(
      "wiki/db.md",
      { title: "DB", kind: "community", status: "stale", triggers: ["src/db/graph.ts"] },
      oldBody,
      newBody,
    );
    expect(d.sectionsAdded).toContain("FTS triggers");
    expect(d.sectionsRemoved).toEqual([]);
    expect(d.sectionsRewritten).toContain("Overview");
    expect(d.citationsAdded).toContain("src/db/graph.ts");
    expect(d.mermaidDelta.oldTypes).toContain("flowchart");
    expect(d.mermaidDelta.newTypes).toContain("sequenceDiagram");
    expect(d.numericLiteralsAdded).toContain("BATCH_SIZE = 32");
    expect(d.numericLiteralsAdded.some((s) => s.includes("DEFAULT_LIMIT = 100"))).toBe(true);
    expect(d.numericLiteralsRemoved.some((s) => s.includes("DEFAULT_LIMIT = 50"))).toBe(true);
  });

  test("added page (oldContent null) reports all sections as added", () => {
    const d = diffPage(
      "wiki/new.md",
      { title: "New", kind: "community", status: "added", triggers: [] },
      null,
      newBody,
    );
    expect(d.status).toBe("added");
    expect(d.sectionsAdded).toEqual(expect.arrayContaining(["Overview", "Tunables", "FTS triggers"]));
    expect(d.sectionsRemoved).toEqual([]);
  });

  test("ignores headings inside fenced code blocks", () => {
    const body = `# Page\n\n## Real\n\n\`\`\`bash\n## not a section\n\`\`\`\n\n## Another\n`;
    const d = diffPage(
      "wiki/x.md",
      { title: "x", kind: "community", status: "added", triggers: [] },
      null,
      body,
    );
    expect(d.sectionsAdded).toEqual(["Real", "Another"]);
  });
});
