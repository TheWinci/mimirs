import type { ProjectAnalysis } from "../../internals/project/analysis.ts";
import {
  callRelationshipLabel,
  importRelationshipLabel,
  reExportRelationshipLabel,
  unresolvedCallLabel,
  unresolvedImportLabel,
  unresolvedReExportLabel,
} from "./source-relationships.ts";

interface ProjectGroup {
  label: string;
  count: number;
  children: string[];
}

function renderGroup(group: ProjectGroup, last: boolean): string[] {
  const connector = last ? "└──" : "├──";
  const lines = [`${connector} ${group.label} [${group.count}]`];
  const indent = last ? "    " : "│   ";
  for (let index = 0; index < group.children.length; index++) {
    const childConnector = index === group.children.length - 1 ? "└──" : "├──";
    lines.push(`${indent}${childConnector} ${group.children[index]}`);
  }
  return lines;
}

/** Compact human projection of one complete project analysis. */
export function renderProjectAnalysis(project: string, analysis: ProjectAnalysis): string {
  const relationships = analysis.relationships;
  const unresolved = [
    ...relationships.unresolvedImports.map(unresolvedImportLabel),
    ...relationships.unresolvedReExports.map(unresolvedReExportLabel),
    ...relationships.unresolvedCalls.map(unresolvedCallLabel),
  ];
  const groups: ProjectGroup[] = [
    { label: "source files", count: analysis.files.length, children: [] },
    {
      label: "imports",
      count: relationships.imports.length,
      children: relationships.imports.map(importRelationshipLabel),
    },
    {
      label: "re-exports",
      count: relationships.reExports.length,
      children: relationships.reExports.map(reExportRelationshipLabel),
    },
    {
      label: "calls",
      count: relationships.calls.length,
      children: relationships.calls.map(callRelationshipLabel),
    },
    { label: "unresolved", count: unresolved.length, children: unresolved },
  ];

  const output = [project];
  for (let index = 0; index < groups.length; index++) {
    output.push(...renderGroup(groups[index]!, index === groups.length - 1));
  }
  return output.join("\n");
}
