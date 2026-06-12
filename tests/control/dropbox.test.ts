import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { createTempDir, cleanupTempDir } from "../helpers";
import {
  PROTOCOL_VERSION,
  commandsDir,
  requestPath,
  resultPath,
  writeAtomic,
  type CommandResult,
} from "../../src/control/protocol";
import { startCommandDropbox, type CommandExecutors } from "../../src/control/consumer";
import { sendCommand, withIndexAccess } from "../../src/control/producer";
import type { Watcher } from "../../src/indexing/watcher";

let tempDir: string;
let consumer: Watcher | null = null;
let holderProc: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(async () => {
  tempDir = await createTempDir();
});

afterEach(async () => {
  consumer?.close();
  consumer = null;
  holderProc?.kill();
  holderProc = null;
  await cleanupTempDir(tempDir);
});

function makeExecutors(overrides: Partial<CommandExecutors> = {}): CommandExecutors {
  return {
    "ping": async () => ({ pid: process.pid, version: "test" }),
    "index.git": async () => ({ indexed: 0, skipped: 0 }),
    "index.conversation": async () => ({ turnsIndexed: 0 }),
    "index.files": async () => ({ indexed: 0, skipped: 0, pruned: 0 }),
    ...overrides,
  };
}

function dropRequest(id: string, body: Record<string, unknown>): string {
  const dir = commandsDir(tempDir);
  mkdirSync(dir, { recursive: true });
  const path = requestPath(dir, id);
  writeAtomic(path, body);
  return path;
}

async function waitForResult(id: string, timeoutMs = 5000): Promise<CommandResult> {
  const path = resultPath(commandsDir(tempDir), id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8")) as CommandResult;
    }
    await Bun.sleep(20);
  }
  throw new Error(`No result for ${id} within ${timeoutMs}ms`);
}

/** Write the index lock as if a live foreign process held it. `sleep` stands
 * in for the server — our own PID can't be used because tryAcquireIndexLock
 * treats a lock bearing the caller's PID as stale and reclaims it. */
function holdLockWithForeignProcess(): number {
  holderProc = Bun.spawn(["sleep", "600"]);
  mkdirSync(join(tempDir, ".mimirs"), { recursive: true });
  writeFileSync(join(tempDir, ".mimirs", "index.lock"), String(holderProc.pid));
  return holderProc.pid;
}

describe("consumer", () => {
  test("executes a ping request and writes an ok result", async () => {
    consumer = startCommandDropbox(tempDir, makeExecutors());
    const reqPath = dropRequest("req-1", {
      id: "req-1", cmd: "ping", args: {}, pid: 1234, version: PROTOCOL_VERSION,
    });

    const result = await waitForResult("req-1");
    expect(result.status).toBe("ok");
    expect(result.stats?.pid).toBe(process.pid);
    expect(existsSync(reqPath)).toBe(false); // request consumed
  });

  test("answers unknown command with unsupported", async () => {
    consumer = startCommandDropbox(tempDir, makeExecutors());
    dropRequest("req-2", {
      id: "req-2", cmd: "flush.everything", args: {}, pid: 1, version: PROTOCOL_VERSION,
    });

    const result = await waitForResult("req-2");
    expect(result.status).toBe("unsupported");
    expect(result.detail).toContain("flush.everything");
  });

  test("answers newer protocol version with unsupported, not silence", async () => {
    consumer = startCommandDropbox(tempDir, makeExecutors());
    dropRequest("req-3", {
      id: "req-3", cmd: "ping", args: {}, pid: 1, version: PROTOCOL_VERSION + 1,
    });

    const result = await waitForResult("req-3");
    expect(result.status).toBe("unsupported");
    expect(result.detail).toContain("upgrade");
  });

  test("rejects invalid args with an error result", async () => {
    consumer = startCommandDropbox(tempDir, makeExecutors());
    dropRequest("req-4", {
      id: "req-4", cmd: "index.git", args: { since: 42 }, pid: 1, version: PROTOCOL_VERSION,
    });

    const result = await waitForResult("req-4");
    expect(result.status).toBe("error");
    expect(result.detail).toContain("index.git");
  });

  test("writes an error result for unparseable JSON instead of ignoring it", async () => {
    const dir = commandsDir(tempDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(requestPath(dir, "req-5"), "{not json");

    consumer = startCommandDropbox(tempDir, makeExecutors());
    const result = await waitForResult("req-5");
    expect(result.status).toBe("error");
    expect(result.detail).toContain("Unparseable");
  });

  test("expires startup requests older than the TTL without executing them", async () => {
    let pings = 0;
    const reqPath = dropRequest("req-6", {
      id: "req-6", cmd: "ping", args: {}, pid: 1, version: PROTOCOL_VERSION,
    });
    const old = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(reqPath, old, old);

    consumer = startCommandDropbox(tempDir, makeExecutors({
      "ping": async () => { pings++; return {}; },
    }));

    const result = await waitForResult("req-6");
    expect(result.status).toBe("expired");
    expect(pings).toBe(0);
  });

  test("fresh startup requests still execute (TTL drain runs them)", async () => {
    dropRequest("req-7", {
      id: "req-7", cmd: "ping", args: {}, pid: 1, version: PROTOCOL_VERSION,
    });

    consumer = startCommandDropbox(tempDir, makeExecutors());
    const result = await waitForResult("req-7");
    expect(result.status).toBe("ok");
  });

  test("does not re-execute a request whose result already exists", async () => {
    let pings = 0;
    const dir = commandsDir(tempDir);
    mkdirSync(dir, { recursive: true });
    writeAtomic(resultPath(dir, "req-8"), { id: "req-8", status: "ok" });
    const reqPath = dropRequest("req-8", {
      id: "req-8", cmd: "ping", args: {}, pid: 1, version: PROTOCOL_VERSION,
    });

    consumer = startCommandDropbox(tempDir, makeExecutors({
      "ping": async () => { pings++; return {}; },
    }));

    // Give the drain a beat, then confirm the request was swallowed unrun.
    await Bun.sleep(200);
    expect(pings).toBe(0);
    expect(existsSync(reqPath)).toBe(false);
  });

  test("serializes commands through the control queue", async () => {
    const order: string[] = [];
    consumer = startCommandDropbox(tempDir, makeExecutors({
      "index.git": async () => {
        order.push("git-start");
        await Bun.sleep(150);
        order.push("git-end");
        return {};
      },
      "ping": async () => {
        order.push("ping");
        return {};
      },
    }));

    dropRequest("req-9a", { id: "req-9a", cmd: "index.git", args: {}, pid: 1, version: PROTOCOL_VERSION });
    await Bun.sleep(50); // let the slow command start first
    dropRequest("req-9b", { id: "req-9b", cmd: "ping", args: {}, pid: 1, version: PROTOCOL_VERSION });

    await waitForResult("req-9b");
    expect(order).toEqual(["git-start", "git-end", "ping"]);
  });
});

describe("producer", () => {
  test("sendCommand round-trips against a live consumer", async () => {
    holdLockWithForeignProcess();
    consumer = startCommandDropbox(tempDir, makeExecutors());

    const result = await sendCommand(tempDir, "ping", {}, { pollMs: 20, timeoutMs: 5000 });
    expect(result.status).toBe("ok");
    expect(result.stats?.pid).toBe(process.pid);
  });

  test("sendCommand fails with holder-died when the lock holder exits", async () => {
    holdLockWithForeignProcess();
    // No consumer — the holder will die before any result appears.
    setTimeout(() => holderProc?.kill(), 100);

    await expect(sendCommand(tempDir, "ping", {}, { pollMs: 20, timeoutMs: 5000 }))
      .rejects.toMatchObject({ kind: "holder-died" });
  });

  test("withIndexAccess runs locally when the lock is free", async () => {
    const access = await withIndexAccess(
      tempDir,
      async () => "ran-local",
      { cmd: "ping", args: {} },
    );
    expect(access).toEqual({ mode: "local", value: "ran-local" });
    // Lock released afterwards.
    expect(existsSync(join(tempDir, ".mimirs", "index.lock"))).toBe(false);
  });

  test("withIndexAccess reclaims a stale lock and runs locally", async () => {
    mkdirSync(join(tempDir, ".mimirs"), { recursive: true });
    writeFileSync(join(tempDir, ".mimirs", "index.lock"), "999999999");

    const access = await withIndexAccess(
      tempDir,
      async () => "ran-local",
      { cmd: "ping", args: {} },
    );
    expect(access).toEqual({ mode: "local", value: "ran-local" });
  });

  test("withIndexAccess routes to a live holder via the drop-box", async () => {
    holdLockWithForeignProcess();
    consumer = startCommandDropbox(tempDir, makeExecutors({
      "index.conversation": async () => ({ turnsIndexed: 7 }),
    }));

    const access = await withIndexAccess(
      tempDir,
      async () => { throw new Error("must not run locally"); },
      { cmd: "index.conversation", args: {} },
      { pollMs: 20 },
    );
    expect(access.mode).toBe("remote");
    if (access.mode === "remote") {
      expect(access.result.status).toBe("ok");
      expect(access.result.stats?.turnsIndexed).toBe(7);
    }
  });

  test("withIndexAccess reports no-channel when a live holder never answers", async () => {
    holdLockWithForeignProcess();
    // No consumer: simulates a pre-channel server holding the lock.

    await expect(withIndexAccess(
      tempDir,
      async () => "unused",
      { cmd: "index.conversation", args: {} },
      { pollMs: 20, probeTimeoutMs: 300 },
    )).rejects.toMatchObject({ kind: "no-channel" });
  });
});
