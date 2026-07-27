import type { SourceChunkKind } from "../types";

export interface CommentNode {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface Entity {
  kind: SourceChunkKind;
  nodeType: string;
  name: string | null;
  nodeStart: number;
  nodeEnd: number;
  startRow: number;
  start: number;
  end: number;
  overloadSignature: boolean;
  children: Entity[];
}
