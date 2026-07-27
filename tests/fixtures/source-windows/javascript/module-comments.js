import { schedule } from "./scheduler.js";

const retryDelay = 250;

/** Schedule the initial task. */
export function initialize(task) {
  return schedule(task, retryDelay);
}

// This comment explains the eager module-level call.
initialize({ kind: "refresh" });
