import type {
  CallRelationship,
  ImportRelationship,
  ReExportRelationship,
  SourceRelationshipResult,
  UnresolvedCall,
  UnresolvedImport,
  UnresolvedReExport,
} from "../../internals/source/relationships.ts";

export function importRelationshipLabel(relationship: ImportRelationship): string {
  const start = Math.min(...relationship.facts.map((fact) => fact.startLine));
  const end = Math.max(...relationship.facts.map((fact) => fact.endLine));
  const lines = start === end ? `${start}` : `${start}–${end}`;
  const target = relationship.targetKind === "package"
    ? `package ${relationship.toPath}`
    : relationship.toPath;
  const source = /^(?:".*"|<.*>)$/.test(relationship.source)
    ? relationship.source
    : `"${relationship.source}"`;
  return `import ${relationship.fromPath} -> ${target} via ${source} [${lines}]`;
}

export function reExportRelationshipLabel(relationship: ReExportRelationship): string {
  const start = Math.min(...relationship.facts.map((fact) => fact.startLine));
  const end = Math.max(...relationship.facts.map((fact) => fact.endLine));
  const lines = start === end ? `${start}` : `${start}–${end}`;
  return `re-export ${relationship.fromPath} -> ${relationship.toPath} via ` +
    `"${relationship.source}" [${lines}]`;
}

export function callRelationshipLabel(relationship: CallRelationship): string {
  const from = relationship.from === null
    ? `${relationship.fromPath}:module`
    : `${relationship.fromPath}:${relationship.from.kind} ${relationship.from.name}`;
  const to = `${relationship.toPath}:${relationship.to.kind} ${relationship.to.name}`;
  return `call ${from} -> ${to} via ${relationship.fact.callee} [${relationship.fact.startLine}]`;
}

export function unresolvedImportLabel(value: UnresolvedImport): string {
  const source = /^(?:".*"|<.*>)$/.test(value.fact.source)
    ? value.fact.source
    : `"${value.fact.source}"`;
  return `unresolved import ${value.path} -> ${source} [${value.fact.startLine}]`;
}

export function unresolvedCallLabel(value: UnresolvedCall): string {
  const owner = value.fact.owner === null
    ? "module"
    : `${value.fact.owner.kind} ${value.fact.owner.name}`;
  return `unresolved call ${value.path}:${owner} -> ${value.fact.callee} [${value.fact.startLine}]`;
}

export function unresolvedReExportLabel(value: UnresolvedReExport): string {
  return `unresolved re-export ${value.path} -> "${value.fact.source}" [${value.fact.startLine}]`;
}

export function renderSourceRelationships(
  project: string,
  result: SourceRelationshipResult,
): string {
  const labels = [
    ...result.imports.map(importRelationshipLabel),
    ...result.reExports.map(reExportRelationshipLabel),
    ...result.calls.map(callRelationshipLabel),
    ...result.unresolvedImports.map(unresolvedImportLabel),
    ...result.unresolvedReExports.map(unresolvedReExportLabel),
    ...result.unresolvedCalls.map(unresolvedCallLabel),
  ];
  const output = [project];
  if (labels.length === 0) labels.push("(no relationships)");
  for (let index = 0; index < labels.length; index++) {
    output.push(`${index === labels.length - 1 ? "└──" : "├──"} ${labels[index]}`);
  }
  return output.join("\n");
}
