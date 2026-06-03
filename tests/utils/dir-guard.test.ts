import { describe, test, expect } from "bun:test";
import { homedir } from "os";
import { checkIndexDir } from "../../src/utils/dir-guard";
import { createTempDir, cleanupTempDir } from "../helpers";

describe("checkIndexDir", () => {
  test("blocks root and system directories", () => {
    for (const d of ["/", "/usr", "/etc", "/opt", "/var", "/System", "/Library", homedir()]) {
      expect(checkIndexDir(d).safe).toBe(false);
    }
  });

  test("blocks a traversal that resolves into a system dir", () => {
    expect(checkIndexDir("/usr/local/..").safe).toBe(false); // → /usr
    expect(checkIndexDir("/etc/foo/../..").safe).toBe(false); // → /
  });

  test("expands ~ to the home dir and blocks it", () => {
    expect(checkIndexDir("~").safe).toBe(false);
  });

  test("allows a normal project directory", async () => {
    const dir = await createTempDir();
    expect(checkIndexDir(dir).safe).toBe(true);
    await cleanupTempDir(dir);
  });
});
