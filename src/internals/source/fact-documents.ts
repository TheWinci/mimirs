import type {
  CallFact,
  ExportFact,
  ImportFact,
  SourceChunkRef,
  SourceFact,
} from "@winci/bun-chunk";

const MAXIMUM_STATEMENTS = 8;
const MAXIMUM_CHARACTERS = 1_200;

export interface FactDocument {
  path: string;
  owner: SourceChunkRef | null;
  startOffset: number;
  text: string;
}

export interface FactDocumentProjection {
  documents: FactDocument[];
  sourceItems: number;
  projectedStatements: number;
}

interface Statement {
  path: string;
  owner: SourceChunkRef | null;
  startOffset: number;
  group: string;
  heading: string;
  text: string;
}

function scope(ref: SourceChunkRef | null): string {
  return ref === null ? "module scope" : `${ref.kind} ${ref.name}`;
}

function importStatement(fact: ImportFact): string {
  const imported = fact.imported === null ? "module" : fact.imported;
  const local = fact.local !== null && fact.local !== imported
    ? ` as ${fact.local}`
    : "";
  const flags = [
    fact.typeOnly ? "type-only" : null,
    fact.static ? "static" : null,
    fact.global ? "global" : null,
  ].filter(Boolean).join(", ");
  return `Imports ${imported} from ${fact.source}${local}` +
    `${flags === "" ? "" : ` (${flags})`}.`;
}

function exportStatement(fact: ExportFact): string {
  const local = fact.local !== null && fact.local !== fact.exported
    ? ` from local ${fact.local}`
    : "";
  const source = fact.source === null ? "" : ` from ${fact.source}`;
  const typeOnly = fact.typeOnly ? " (type-only)" : "";
  return `Exports ${fact.exported}${local}${source}${typeOnly}.`;
}

function callStatement(fact: CallFact): string {
  const target = fact.target === null
    ? ""
    : ` resolved to ${fact.target.kind} ${fact.target.name}`;
  return `Calls ${fact.callee}${target} (binding: ${fact.binding}).`;
}

function factStatement(fact: SourceFact): string {
  if (fact.kind === "import") return importStatement(fact);
  if (fact.kind === "export") return exportStatement(fact);
  return callStatement(fact);
}

/** Project one file's raw observations into bounded, deterministic scope documents. */
export function projectFactDocuments(
  path: string,
  facts: readonly SourceFact[],
): FactDocumentProjection {
  const statements: Statement[] = facts.map((fact) => {
    const owner = fact.owner;
    return {
      path,
      owner,
      startOffset: fact.startOffset,
      group: `${path}\0${owner?.startOffset ?? -1}`,
      heading: `Facts observed in ${scope(owner)}.`,
      text: factStatement(fact),
    };
  });
  const groups = new Map<string, Statement[]>();
  for (const statement of statements) {
    const values = groups.get(statement.group) ?? [];
    values.push(statement);
    groups.set(statement.group, values);
  }
  const documents: FactDocument[] = [];
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
  return { documents, sourceItems: statements.length, projectedStatements };
}
