export function formatLabel(value) {
  return value.trim();
}

export async function loadValue(fetcher) {
  return fetcher();
}

export const double = (value) => value * 2;

export function* integerRange(start, end) {
  for (let value = start; value < end; value++) {
    yield value;
  }
}
