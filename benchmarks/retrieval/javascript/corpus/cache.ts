import { readFileSync } from "node:fs";

export namespace Sessions {
  export interface Entry { token: string; expiresAt: number; }

  /** Keep browser tokens until their expiration time in milliseconds. */
  export class TokenCache {
    private entries = new Map<string, Entry>();

    /** Remove tokens whose expiration deadline has elapsed. */
    removeExpired(nowMs: number): number {
      let removed = 0;
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt <= nowMs) {
          this.entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    }

    /** Restore browser tokens from a JSON file after a restart. */
    static restore(path: string): TokenCache {
      const cache = new TokenCache();
      for (const entry of JSON.parse(readFileSync(path, "utf8"))) {
        cache.entries.set(entry.token, entry);
      }
      return cache;
    }
  }
}
