abstract class Store<T> {
  abstract get(key: string): T | undefined;
}

export class MemoryStore<T> extends Store<T> {
  static readonly kind = "memory";
  readonly #items = new Map<string, T>();

  constructor(initial: Iterable<readonly [string, T]> = []) {
    super();
    for (const [key, value] of initial) {
      this.#items.set(key, value);
    }
  }

  override get(key: string): T | undefined {
    return this.#items.get(key);
  }

  set(key: string, value: T): void {
    this.#items.set(key, value);
  }

  get size(): number {
    return this.#items.size;
  }

  async load(key: string): Promise<T | undefined> {
    return this.get(key);
  }

  *entries(): Generator<readonly [string, T]> {
    yield* this.#items.entries();
  }

  static empty<T>(): MemoryStore<T> {
    return new MemoryStore<T>();
  }
}
