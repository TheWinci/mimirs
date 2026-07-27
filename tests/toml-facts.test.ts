import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "toml");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

describe("TOML source facts", () => {
  test("does not invent imports or calls from tool-specific property names", async () => {
    expect((await result("semantic-traps.toml")).facts).toEqual([]);
  });

  test("does not interpret paths and inline tables as source facts", async () => {
    expect((await result("document.toml")).facts).toEqual([]);
    expect((await result("values.toml")).facts).toEqual([]);
  });
});
