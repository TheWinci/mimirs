export class MemoryStore {
  #items = new Map();

  constructor(entries = []) {
    for (const [key, value] of entries) {
      this.#items.set(key, value);
    }
  }

  get(key) {
    return this.#items.get(key);
  }

  set(key, value) {
    this.#items.set(key, value);
  }

  static create(entries) {
    return new MemoryStore(entries);
  }
}
