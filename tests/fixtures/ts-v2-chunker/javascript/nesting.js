export function createFormatter(prefix) {
  function normalize(value) {
    return value.trim().toLowerCase();
  }

  const surround = (value) => `${prefix}${value}${prefix}`;

  return function decorate(value) {
    return surround(normalize(value));
  };
}

export class Formatter {
  trim(value) {
    return value.trim();
  }

  format(value) {
    return this.trim(value);
  }
}
