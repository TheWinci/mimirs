import type {
  CallFact,
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
  SourceChunkResult,
  SourceFact,
} from "@winci/bun-chunk";


export interface RelationshipSourceResult {
  language: SourceChunkResult["language"];
  chunks: SourceChunk[];
  facts: SourceFact[];
}

export interface AnalyzedSourceFile {
  path: string;
  result: RelationshipSourceResult;
}

export interface ImportRelationship {
  kind: "import";
  fromPath: string;
  targetKind: "file" | "package";
  toPath: string;
  source: string;
  facts: ImportFact[];
}

export interface ReExportRelationship {
  kind: "re-export";
  fromPath: string;
  toPath: string;
  source: string;
  facts: ExportFact[];
}

export interface CallRelationship {
  kind: "call";
  fromPath: string;
  from: SourceChunkRef | null;
  toPath: string;
  to: SourceChunkRef;
  fact: CallFact;
}

export interface UnresolvedImport {
  path: string;
  fact: ImportFact;
}

export interface UnresolvedCall {
  path: string;
  fact: CallFact;
}

export interface UnresolvedReExport {
  path: string;
  fact: ExportFact;
}

export interface SourceRelationshipResult {
  imports: ImportRelationship[];
  reExports: ReExportRelationship[];
  calls: CallRelationship[];
  unresolvedImports: UnresolvedImport[];
  unresolvedReExports: UnresolvedReExport[];
  unresolvedCalls: UnresolvedCall[];
}

export interface SourceRelationshipOptions {
  goModulePath?: string | null;
  projectPaths?: ReadonlySet<string>;
}

export interface FileContext extends AnalyzedSourceFile {
  path: string;
  topLevelChunks: SourceChunkRef[];
  imports: ImportFact[];
  exports: ExportFact[];
  calls: CallFact[];
}
