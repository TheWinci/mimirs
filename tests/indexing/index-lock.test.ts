import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tryAcquireIndexLock } from "../../src/utils/index-lock";
import { createTempDir, cleanupTempDir } from "../helpers";

let tempDir: string;

afterEach(async () => {
  if (tempDir) await cleanupTempDir(tempDir);
});

describe("tryAcquireIndexLock", () => {
  test("acquires when no lock file exists", async () => {
    tempDir = await createTempDir();
    const lock = tryAcquireIndexLock(tempDir);
    expect(lock).not.toBeNull();
    expect(existsSync(join(tempDir, ".mimirs", "index.lock"))).toBe(true);
    lock!.release();
    expect(existsSync(join(tempDir, ".mimirs", "index.lock"))).toBe(false);
  });

  test("reentrant within same process", async () => {
    tempDir = await createTempDir();
    const a = tryAcquireIndexLock(tempDir);
    const b = tryAcquireIndexLock(tempDir);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!.release();
    // Lock file still present because b still holds it
    expect(existsSync(join(tempDir, ".mimirs", "index.lock"))).toBe(true);
    b!.release();
    expect(existsSync(join(tempDir, ".mimirs", "index.lock"))).toBe(false);
  });

  test("returns null when another live PID holds the lock", async () => {
    tempDir = await createTempDir();
    mkdirSync(join(tempDir, ".mimirs"), { recursive: true });
    // Write parent process's pid into the lock — parent is this test
    // runner's spawning shell, which is alive. Use a known-live pid that
    // isn't ours: process.ppid.
    writeFileSync(join(tempDir, ".mimirs", "index.lock"), String(process.ppid));

    const lock = tryAcquireIndexLock(tempDir);
    expect(lock).toBeNull();

    // Lock file untouched — we didn't own it
    const content = readFileSync(join(tempDir, ".mimirs", "index.lock"), "utf-8").trim();
    expect(content).toBe(String(process.ppid));
  });

  test("reclaims stale lock from dead PID", async () => {
    tempDir = await createTempDir();
    mkdirSync(join(tempDir, ".mimirs"), { recursive: true });
    // PID 999999 — astronomically unlikely to be assigned on this system.
    writeFileSync(join(tempDir, ".mimirs", "index.lock"), "999999");

    const lock = tryAcquireIndexLock(tempDir);
    expect(lock).not.toBeNull();
    const content = readFileSync(join(tempDir, ".mimirs", "index.lock"), "utf-8").trim();
    expect(content).toBe(String(process.pid));
    lock!.release();
  });

  test("treats unreadable lock as stale", async () => {
    tempDir = await createTempDir();
    mkdirSync(join(tempDir, ".mimirs"), { recursive: true });
    writeFileSync(join(tempDir, ".mimirs", "index.lock"), "garbage-not-a-pid");

    const lock = tryAcquireIndexLock(tempDir);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  test("release is idempotent", async () => {
    tempDir = await createTempDir();
    const lock = tryAcquireIndexLock(tempDir);
    expect(lock).not.toBeNull();
    lock!.release();
    lock!.release(); // should not throw
    expect(existsSync(join(tempDir, ".mimirs", "index.lock"))).toBe(false);
  });
});
