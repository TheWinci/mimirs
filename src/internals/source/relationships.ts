export { connectSourceFiles } from "./relationships/connect.ts";
export { parseGoModulePath } from "./relationships/shared.ts";
export type {
  AnalyzedSourceFile,
  CallRelationship,
  ImportRelationship,
  ReExportRelationship,
  RelationshipSourceResult,
  SourceRelationshipOptions,
  SourceRelationshipResult,
  UnresolvedCall,
  UnresolvedImport,
  UnresolvedReExport,
} from "./relationships/types.ts";
