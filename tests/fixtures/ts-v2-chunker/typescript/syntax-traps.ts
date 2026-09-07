const fakeFunction = "function imaginary() { return '}'; }";
const fakeClass = `class NotReal { method() { return "{"; } }`;
const bracePattern = /[{}](?:function|class)?/g;

// function commentedOut(): void { throw new Error("not real"); }

const π = Math.PI;
const 名前 = "chunker";

export function render(values: number[]): string {
  const descriptions = values.map((value) => {
    if (value > π) {
      return `{large:${value}}`;
    }
    return `{small:${value}}`;
  });

  return `${名前}:${descriptions.join(",")}:${fakeFunction}:${fakeClass}:${bracePattern}`;
}
