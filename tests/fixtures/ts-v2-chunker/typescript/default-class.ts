export default class {
  #value = 0;

  constructor(initial = 0) {
    this.#value = initial;
  }

  increment(): void {
    this.#value++;
  }

  get current(): number {
    return this.#value;
  }
}
