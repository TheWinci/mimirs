import type { SourceChunk } from "@winci/bun-chunk";

import {
  sourceWindowPreview,
  type SourceWindow,
} from "../../internals/source/windows.ts";

interface WindowGroup {
  sourceChunk: SourceChunk;
  windows: SourceWindow[];
}

function lines(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}–${endLine}`;
}

function sourceChunkLabel(chunk: SourceChunk): string {
  const name = chunk.name ? ` ${chunk.name.replace(/\s+/g, " ").trim()}` : "";
  return `${chunk.kind}${name} [${lines(chunk.startLine, chunk.endLine)}]`;
}

function groups(windows: SourceWindow[]): WindowGroup[] {
  const grouped: WindowGroup[] = [];
  for (const window of windows) {
    const previous = grouped.at(-1);
    if (previous?.sourceChunk === window.sourceChunk) {
      previous.windows.push(window);
    } else {
      grouped.push({
        sourceChunk: window.sourceChunk,
        windows: [window],
      });
    }
  }
  return grouped;
}

/** Human-reviewable projection of source chunks and their embedding windows. */
export function renderSourceWindowTree(
  path: string,
  windows: SourceWindow[],
  previewCharacters?: number,
): string {
  const grouped = groups(windows);
  const output = [path];
  for (let groupIndex = 0; groupIndex < grouped.length; groupIndex++) {
    const group = grouped[groupIndex]!;
    const lastGroup = groupIndex === grouped.length - 1;
    output.push(
      `${lastGroup ? "└──" : "├──"} ${sourceChunkLabel(group.sourceChunk)}`,
    );
    const prefix = lastGroup ? "    " : "│   ";
    for (let index = 0; index < group.windows.length; index++) {
      const window = group.windows[index]!;
      const lastWindow = index === group.windows.length - 1;
      output.push(
        `${prefix}${lastWindow ? "└──" : "├──"} window ` +
          `[${lines(window.startLine, window.endLine)}] ` +
          `(${window.text.length} chars) ` +
          `“${sourceWindowPreview(window, previewCharacters)}”`,
      );
    }
  }
  return output.join("\n");
}
