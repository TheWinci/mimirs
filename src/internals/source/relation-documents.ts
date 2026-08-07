import type { SourceChunkRef } from "@winci/bun-chunk";

import type { SourceRelationshipResult } from "./relationships.ts";

const MAXIMUM_STATEMENTS = 8;
const MAXIMUM_CHARACTERS = 1_200;

export type RelationDocumentDirection = "incoming" | "outgoing";
export type RelationDocumentKind = "import" | "re-export" | "call";

export interface RelationDocument {
  path: string;
  owner: SourceChunkRef | null;
  startOffset: number;
  direction: RelationDocumentDirection;
  kind: RelationDocumentKind;
  text: string;
}

export interface RelationDocumentProjection {
  documents: RelationDocument[];
  sourceItems: number;
  projectedStatements: number;
}

interface Statement {
  path: string;
  owner: SourceChunkRef | null;
  startOffset: number;
  direction: RelationDocumentDirection;
  kind: RelationDocumentKind;
  group: string;
  heading: string;
  text: string;
}

function scope(ref: SourceChunkRef | null): string {
  return ref === null ? "module scope" : `${ref.kind} ${ref.name}`;
}

function materialize(
  statements: readonly Statement[],
): RelationDocumentProjection {
  const groups = new Map<string, Statement[]>();
  for (const statement of statements) {
    const values = groups.get(statement.group) ?? [];
    values.push(statement);
    groups.set(statement.group, values);
  }
  const documents: RelationDocument[] = [];
  let projectedStatements = 0;
  for (const key of [...groups.keys()].sort()) {
    const values = groups.get(key)!.sort((left, right) =>
      left.startOffset - right.startOffset || left.text.localeCompare(right.text)
    );
    const distinct = [...new Map(values.map((value) => [value.text, value])).values()];
    projectedStatements += distinct.length;
    let batch: Statement[] = [];
    const flush = () => {
      if (batch.length === 0) return;
      const first = batch[0]!;
      documents.push({
        path: first.path,
        owner: first.owner,
        startOffset: Math.min(...batch.map((value) => value.startOffset)),
        direction: first.direction,
        kind: first.kind,
        text: `${first.heading}\nFile: ${first.path}\n` +
          batch.map((value) => value.text).join("\n"),
      });
      batch = [];
    };
    for (const statement of distinct) {
      const nextCharacters = batch.reduce(
        (sum, value) => sum + value.text.length + 1,
        0,
      ) + statement.text.length;
      if (
        batch.length >= MAXIMUM_STATEMENTS ||
        (batch.length > 0 && nextCharacters > MAXIMUM_CHARACTERS)
      ) {
        flush();
      }
      batch.push(statement);
    }
    flush();
  }
  return {
    documents,
    sourceItems: statements.length,
    projectedStatements,
  };
}

/** Project resolved graph edges in both directions with typed provenance. */
export function projectRelationDocuments(
  relationships: SourceRelationshipResult,
): RelationDocumentProjection {
  const statements: Statement[] = [];
  for (const relation of relationships.imports) {
    const owner = relation.facts[0]?.owner ?? null;
    const sourceOffset = relation.facts[0]?.startOffset ?? 0;
    statements.push({
      path: relation.fromPath,
      owner,
      startOffset: sourceOffset,
      direction: "outgoing",
      kind: "import",
      group: `out\0${relation.fromPath}\0${owner?.startOffset ?? -1}\0import`,
      heading: `Outgoing import relationships for ${scope(owner)}.`,
      text: `Imports ${relation.targetKind} ${relation.toPath} via ${relation.source}.`,
    });
    if (relation.targetKind === "file") {
      statements.push({
        path: relation.toPath,
        owner: null,
        startOffset: 0,
        direction: "incoming",
        kind: "import",
        group: `in\0${relation.toPath}\0import`,
        heading: "Incoming import relationships for this file.",
        text: `Imported by ${relation.fromPath} via ${relation.source}.`,
      });
    }
  }
  for (const relation of relationships.reExports) {
    const owner = relation.facts[0]?.owner ?? null;
    const sourceOffset = relation.facts[0]?.startOffset ?? 0;
    statements.push({
      path: relation.fromPath,
      owner,
      startOffset: sourceOffset,
      direction: "outgoing",
      kind: "re-export",
      group: `out\0${relation.fromPath}\0${owner?.startOffset ?? -1}\0re-export`,
      heading: `Outgoing re-export relationships for ${scope(owner)}.`,
      text: `Re-exports ${relation.toPath} via ${relation.source}.`,
    });
    statements.push({
      path: relation.toPath,
      owner: null,
      startOffset: 0,
      direction: "incoming",
      kind: "re-export",
      group: `in\0${relation.toPath}\0re-export`,
      heading: "Incoming re-export relationships for this file.",
      text: `Re-exported by ${relation.fromPath} via ${relation.source}.`,
    });
  }
  for (const relation of relationships.calls) {
    statements.push({
      path: relation.fromPath,
      owner: relation.from,
      startOffset: relation.fact.startOffset,
      direction: "outgoing",
      kind: "call",
      group: `out\0${relation.fromPath}\0${relation.from?.startOffset ?? -1}\0call`,
      heading: `Outgoing call relationships for ${scope(relation.from)}.`,
      text: `Calls ${relation.to.kind} ${relation.to.name} in ${relation.toPath}.`,
    });
    statements.push({
      path: relation.toPath,
      owner: relation.to,
      startOffset: relation.to.startOffset,
      direction: "incoming",
      kind: "call",
      group: `in\0${relation.toPath}\0${relation.to.startOffset}\0call`,
      heading: `Incoming call relationships for ${scope(relation.to)}.`,
      text: `Called by ${scope(relation.from)} in ${relation.fromPath}.`,
    });
  }
  return materialize(statements);
}
