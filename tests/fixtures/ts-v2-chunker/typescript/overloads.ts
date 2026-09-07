export function parse(value: string): string;
export function parse(value: number): string;
export function parse(value: string | number): string {
  return String(value);
}

export class Parser {
  parse(value: string): string;
  parse(value: Uint8Array): string;
  parse(value: string | Uint8Array): string {
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }
}

export interface Codec {
  encode(value: string): Uint8Array;
  encode(value: Uint8Array): string;
}
