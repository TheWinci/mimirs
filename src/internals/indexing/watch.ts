import { watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";

export interface ProjectWatchObserver {
  close(): void;
}

export type ProjectWatchObserverFactory = (
  root: string,
  onChange: () => void,
  onError: (error: Error) => void,
) => ProjectWatchObserver;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Observe the sole source root and its config. State writes are ignored so a
 * completed refresh cannot schedule itself.
 */
export const observeProject: ProjectWatchObserverFactory = (
  root,
  onChange,
  onError,
) => {
  const watchers: FSWatcher[] = [];
  const stateDirectory = join(root, ".mimirs");
  try {
    const source = watch(root, { recursive: true }, (_event, filename) => {
      if (filename === null) {
        onChange();
        return;
      }
      const relative = filename.toString().replaceAll("\\", "/");
      if (relative === ".mimirs" || relative.startsWith(".mimirs/")) return;
      onChange();
    });
    source.on("error", (error) => onError(asError(error)));
    watchers.push(source);

    const config = watch(stateDirectory, (_event, filename) => {
      if (filename === null || basename(filename.toString()) === "config.json") {
        onChange();
      }
    });
    config.on("error", (error) => onError(asError(error)));
    watchers.push(config);
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }

  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      for (const watcher of watchers) watcher.close();
    },
  };
};

export interface RefreshCoordinatorOptions {
  debounceMs?: number;
  maximumDelayMs?: number;
  onError?: (error: Error) => void | Promise<void>;
}

/**
 * Coalesce event bursts into serialized authoritative refreshes. An event
 * received during a refresh produces exactly one immediate follow-up.
 */
export class RefreshCoordinator {
  private readonly debounceMs: number;
  private readonly maximumDelayMs: number;
  private readonly onError: (error: Error) => void | Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstEventAt: number | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly refresh: () => Promise<void>,
    options: RefreshCoordinatorOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 150;
    this.maximumDelayMs = options.maximumDelayMs ?? 1_000;
    this.onError = options.onError ?? (() => undefined);
  }

  notify(): void {
    if (this.closed) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    const now = Date.now();
    this.firstEventAt ??= now;
    const dueAt = Math.min(
      now + this.debounceMs,
      this.firstEventAt + this.maximumDelayMs,
    );
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, Math.max(0, dueAt - now));
  }

  async refreshNow(): Promise<void> {
    if (this.closed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.run();
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.running;
      return;
    }
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private async run(): Promise<void> {
    if (this.closed || this.running) return;
    this.firstEventAt = null;
    const operation = (async () => {
      try {
        await this.refresh();
      } catch (error) {
        await this.onError(asError(error));
      }
    })();
    this.running = operation;
    await operation;
    this.running = null;
    if (this.dirty && !this.closed) {
      this.dirty = false;
      await this.run();
    }
  }
}
