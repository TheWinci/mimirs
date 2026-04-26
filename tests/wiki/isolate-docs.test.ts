import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  collectIsolateDocs,
  attachIsolateDocs,
  type CommunityClaim,
  type NearbyDoc,
} from "../../src/wiki/isolate-docs";
import type { FileLevelGraph, FileLevelNode } from "../../src/wiki/types";

function isolate(path: string): FileLevelNode {
  return { path, exports: [], fanIn: 0, fanOut: 0, isEntryPoint: false };
}

function sourceNode(path: string): FileLevelNode {
  return {
    path,
    exports: [{ name: "x", type: "function" }],
    fanIn: 1,
    fanOut: 0,
    isEntryPoint: false,
  };
}

describe("collectIsolateDocs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "isolate-docs-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads markdown + shell isolates, skips json/lock/binary", () => {
    mkdirSync(join(dir, "src", "wiki"), { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "src", "wiki", "exemplar.md"), "# Exemplar\n");
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(join(dir, "scripts", "setup.bash"), "#!/bin/bash\n");
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "bun.lock"), "");

    const graph: FileLevelGraph = {
      level: "file",
      nodes: [
        isolate("src/wiki/exemplar.md"),
        isolate("scripts/run.sh"),
        isolate("scripts/setup.bash"),
        isolate("config.json"),
        isolate("bun.lock"),
        sourceNode("src/wiki/mod.ts"),
      ],
      edges: [],
    };

    const docs = collectIsolateDocs(graph, dir);
    const paths = docs.map((d) => d.path).sort();
    expect(paths).toEqual(["scripts/run.sh", "scripts/setup.bash", "src/wiki/exemplar.md"]);
  });

  test("skips source files even if they happen to end in .md-like path component", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "real.ts"), "export const x = 1;");

    const graph: FileLevelGraph = {
      level: "file",
      nodes: [sourceNode("src/real.ts")],
      edges: [],
    };

    expect(collectIsolateDocs(graph, dir)).toEqual([]);
  });

  test("reads file content verbatim — no size cap", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    const big = "x".repeat(32 * 1024);
    writeFileSync(join(dir, "docs", "big.md"), big);

    const graph: FileLevelGraph = {
      level: "file",
      nodes: [isolate("docs/big.md")],
      edges: [],
    };

    const docs = collectIsolateDocs(graph, dir);
    expect(docs[0].content.length).toBe(32 * 1024);
  });
});

describe("attachIsolateDocs", () => {
  function claim(id: string, path: string, size: number, cohesion = 1): CommunityClaim {
    const memberFiles = Array.from({ length: size }, (_, i) => `${path}/f${i}.ts`);
    return { communityId: id, memberFiles, cohesion };
  }

  test("attaches doc to community sharing the longest dir prefix (≥2 segments)", () => {
    const communities = [claim("wiki", "src/wiki", 4), claim("db", "src/db", 4)];
    const docs: NearbyDoc[] = [
      { path: "src/wiki/exemplar.md", content: "a" },
      { path: "src/db/schema.md", content: "b" },
    ];
    const { byCommunityId, unmatched } = attachIsolateDocs(docs, communities);
    expect(byCommunityId.get("wiki")!.map((d) => d.path)).toEqual(["src/wiki/exemplar.md"]);
    expect(byCommunityId.get("db")!.map((d) => d.path)).toEqual(["src/db/schema.md"]);
    expect(unmatched).toEqual([]);
  });

  test("unmatched when shared prefix below threshold", () => {
    const communities = [claim("wiki", "src/wiki", 4)];
    // `docs/tools.md` shares zero dirs with `src/wiki/` — stays unmatched.
    const docs: NearbyDoc[] = [{ path: "docs/tools.md", content: "x" }];
    const { byCommunityId, unmatched } = attachIsolateDocs(docs, communities);
    expect(byCommunityId.get("wiki")).toEqual([]);
    expect(unmatched.map((d) => d.path)).toEqual(["docs/tools.md"]);
  });

  test("caps attached docs by cohesion — low-cohesion gets fewer", () => {
    const communities = [claim("low", "src/grab", 4, 0.05)];
    const docs: NearbyDoc[] = Array.from({ length: 10 }, (_, i) => ({
      path: `src/grab/note${i}.md`,
      content: "x",
    }));
    const { byCommunityId, unmatched } = attachIsolateDocs(docs, communities);
    expect(byCommunityId.get("low")!.length).toBe(3);
    expect(unmatched.length).toBe(7);
  });

  test("high-cohesion cap is 8", () => {
    const communities = [claim("high", "src/grab", 4, 0.9)];
    const docs: NearbyDoc[] = Array.from({ length: 12 }, (_, i) => ({
      path: `src/grab/note${i}.md`,
      content: "x",
    }));
    const { byCommunityId, unmatched } = attachIsolateDocs(docs, communities);
    expect(byCommunityId.get("high")!.length).toBe(8);
    expect(unmatched.length).toBe(4);
  });

  test("ties break by member-file count", () => {
    // Both communities share depth=2 with `src/shared/foo.md`. Bigger one wins.
    const small = claim("small", "src/shared", 2);
    const big = claim("big", "src/shared", 10);
    const docs: NearbyDoc[] = [{ path: "src/shared/foo.md", content: "x" }];
    const { byCommunityId } = attachIsolateDocs(docs, [small, big]);
    expect(byCommunityId.get("big")!.length).toBe(1);
    expect(byCommunityId.get("small")!.length).toBe(0);
  });
});
