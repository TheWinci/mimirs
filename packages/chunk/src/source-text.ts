import { basename, extname } from "node:path";

import type { Language } from "./types";
import { EXTENSION_MAP } from "./types";

export interface PreparedSource {
  source: string;
  language: Language | null;
  binary: boolean;
  opaque: string | null;
  lineStarts: number[];
}

export function normalize(code: string): string {
  if (code.charCodeAt(0) === 0xfeff) code = code.slice(1);
  return code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

export function offsetToRow(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function prepareSource(
  filepath: string,
  code: string,
  language?: Language,
): PreparedSource {
  const source = normalize(code);
  return {
    source,
    language: language ?? detectLanguage(filepath),
    binary: isBinary(source),
    opaque: detectOpaque(filepath, source),
    lineStarts: buildLineStarts(source),
  };
}

function detectLanguage(filepath: string): Language | null {
  return EXTENSION_MAP[extname(filepath).toLowerCase()] ?? null;
}

function isBinary(source: string): boolean {
  return source.slice(0, 8192).includes("\u0000");
}

function detectOpaque(filepath: string, source: string): string | null {
  const reasons: string[] = [];
  if (/\.min\.[a-z]+$/i.test(basename(filepath))) {
    reasons.push("minified filename (*.min.*)");
  }

  const lines = source.split("\n");
  let maximumLineLength = 0;
  let nonEmptyLines = 0;
  let totalLineLength = 0;
  for (const line of lines) {
    if (line.length > maximumLineLength) maximumLineLength = line.length;
    if (line.trim()) {
      nonEmptyLines++;
      totalLineLength += line.length;
    }
  }
  if (maximumLineLength > 10_000) {
    reasons.push(`line length ${maximumLineLength} exceeds 10000`);
  }
  if (nonEmptyLines >= 50 && totalLineLength / nonEmptyLines > 300) {
    reasons.push(
      `average line length ${
        Math.round(totalLineLength / nonEmptyLines)
      } exceeds 300`,
    );
  }
  return reasons.length > 0 ? reasons.join("; ") : null;
}
