

export const SEARCH_DOCUMENT_LIMIT = 5;
export const SEARCH_DOCUMENTS_INSPECTED = 10;
export const SEARCH_DOCUMENT_WINDOWS = 6;
export const SEARCH_DOCUMENT_REFERENCES = 10;
export const SEARCH_DOCUMENT_REFERENCES_PER_FILE = 3;
export const SEARCH_DOCUMENT_INHERITED_SCORE = 0.6;
export const DOCUMENT_EXTENSION = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
export const EXPLICIT_PATH =
  /(?:^|[\s`'"(<])((?:\.{0,2}\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.+-]+)+\.[A-Za-z0-9][A-Za-z0-9.-]*)(?:$|[\s`'">),.:#])/g;
export const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
export const QUALIFIED_SYMBOL =
  /\b(?:[a-zA-Z_][a-zA-Z0-9_]*\.){2,}[A-Z][a-zA-Z0-9_]*\b/g;
