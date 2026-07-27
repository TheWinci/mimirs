/** Keep pending jobs in insertion order. */
export class JobQueue {
  #jobs = [];

  constructor(initial = []) {
    this.#jobs.push(...initial);
  }

  enqueue(job) {
    this.#jobs.push(job);
  }

  peek() {
    return this.#jobs[0] ?? null;
  }

  drain(limit = this.#jobs.length) {
    const selected = this.#jobs.slice(0, limit);
    this.#jobs = this.#jobs.slice(limit);
    return selected;
  }

  get size() {
    return this.#jobs.length;
  }

  static empty() {
    return new JobQueue();
  }
}
