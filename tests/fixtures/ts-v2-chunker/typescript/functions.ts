function add(left: number, right: number): number {
  return left + right;
}

export async function fetchLabel(id: string): Promise<string> {
  return `label:${id}`;
}

export function* integerRange(start: number, end: number): Generator<number> {
  for (let value = start; value < end; value++) {
    yield value;
  }
}

export const double = (value: number): number => value * 2;

export function identity<T>(value: T): T {
  return value;
}
