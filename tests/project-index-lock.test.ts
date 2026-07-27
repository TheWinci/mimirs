import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readProjectIndexLock,
  tryAcquireProjectIndexLock,
} from "../src/internals/indexing/lock.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mimirs-project-lock-"));
  temporaryDirectories.push(root);
  return root;
}

describe("project index ownership lock", () => {
  test("elects one instance even when contenders share a process", async () => {
    const root = await project();
    const contenders = await Promise.all([
      tryAcquireProjectIndexLock(root, "first"),
      tryAcquireProjectIndexLock(root, "second"),
    ]);
    const winner = contenders.find((lock) => lock !== null)!;
    expect(contenders.filter((lock) => lock !== null)).toHaveLength(1);
    const winnerId = winner.owner.instanceId;
    expect(await readProjectIndexLock(root)).toMatchObject({
      instanceId: winnerId,
      pid: process.pid,
    });

    await winner.release();
    const replacement = await tryAcquireProjectIndexLock(root, "replacement");
    expect(replacement).not.toBeNull();
    await replacement!.release();
    expect(await readProjectIndexLock(root)).toBeNull();
  });

  test("reclaims a malformed or dead-owner lock", async () => {
    const root = await project();
    await mkdir(join(root, ".mimirs"));
    await writeFile(
      join(root, ".mimirs", "index.lock"),
      JSON.stringify({
        version: 1,
        instanceId: "dead",
        pid: 2_147_483_647,
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const lock = await tryAcquireProjectIndexLock(root, "replacement");
    expect(lock).not.toBeNull();
    expect(await readProjectIndexLock(root)).toMatchObject({
      instanceId: "replacement",
      pid: process.pid,
    });
    await lock!.release();
  });

  test("only releases a lock still owned by the same instance", async () => {
    const root = await project();
    const lock = await tryAcquireProjectIndexLock(root, "owner");
    expect(lock).not.toBeNull();
    await writeFile(
      join(root, ".mimirs", "index.lock"),
      JSON.stringify({
        version: 1,
        instanceId: "replacement",
        pid: process.pid,
        acquiredAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await lock!.release();
    expect(await readProjectIndexLock(root)).toMatchObject({
      instanceId: "replacement",
    });
  });
});
