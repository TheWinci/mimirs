function registered<T extends abstract new (...args: any[]) => object>(target: T): T {
  return target;
}

/** Convert a value to its display form. */
export function documented(value: number): string {
  return String(value);
}

// This comment is standalone because a blank line follows it.

export const DEFAULT_VALUE = 10;

function previous(): void {} // This trailing comment must not attach forward.
export function next(): void {}

// This line belongs to the class below it.
@registered
export class Service {
  /** Return the current service status. */
  status(): string {
    return "ready";
  }
}
