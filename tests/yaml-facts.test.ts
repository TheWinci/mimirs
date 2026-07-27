import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "yaml");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

describe("YAML source facts", () => {
  test("does not invent imports or calls from schema-specific keys", async () => {
    expect((await result("semantic-traps.yaml")).facts).toEqual([]);
  });

  test("does not interpret anchors, aliases, tags, or URLs as source facts", async () => {
    expect((await result("anchors.yaml")).facts).toEqual([]);
  });

  test("routes both YAML extensions through reviewed support", async () => {
    expect((await result("document.yaml")).language).toBe("yaml");
    expect((await result("documents.yml")).language).toBe("yaml");
  });
});
