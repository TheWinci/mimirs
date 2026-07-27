export function createFormatter(prefix: string): (value: string) => string {
  function normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  const decorate = (value: string): string => {
    function surround(text: string): string {
      return `[${text}]`;
    }

    return surround(`${prefix}:${normalize(value)}`);
  };

  return decorate;
}

export class Formatter {
  format(value: string): string {
    function trim(text: string): string {
      return text.trim();
    }

    const appendPeriod = (text: string): string => `${text}.`;
    return appendPeriod(trim(value));
  }
}
