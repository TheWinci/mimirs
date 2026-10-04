// Sample file for chunking tests, written for this repository.

import { run } from "./run";
import type { Task } from "./task";

/** Default number of tasks a queue holds. */
export const DEFAULT_LIMIT = 100;

export interface QueueOptions {
  limit: number;
  onDrain?: () => void;
}

export type Priority = "low" | "high";

export enum State {
  Idle,
  Running,
}

/**
 * Runs tasks one after another.
 */
export class Queue {
  private items: Task[] = [];

  constructor(private options: QueueOptions) {}

  push(task: Task) { this.items.push(task); }
  size() { return this.items.length; } drain() {
    while (this.items.length) run(this.items.shift()!);
  }

  // Called when the last task finishes.
  private handleDone = (task: Task) => {
    this.options.onDrain?.();
  };
}

export function createQueue(
  limit: number,
  onDrain?: () => void,
): Queue {
  return new Queue({ limit, onDrain });
}

export const schedule = async (queue: Queue, task: Task) => {
  queue.push(task);
};

export namespace Scheduler {
  export function start() {}
}

declare global {
  interface Window {
    queue: Queue;
  }
}

export default function () {
  return createQueue(DEFAULT_LIMIT);
}

export { run };

createQueue(1).drain();
