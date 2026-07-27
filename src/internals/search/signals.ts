const CODE_IDENTIFIER_RE =
  /\b[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?\b/g;

const CODE_IDENTIFIER_STOP_WORDS = new Set([
  "the", "and", "for", "from", "with", "that", "this", "what", "when",
  "where", "how", "all", "not", "but", "has", "have", "get", "set",
  "new", "use", "can", "will", "should", "into", "each", "only",
  "does", "file", "files", "code", "function", "method", "class",
  "type", "return", "error", "value", "data", "name", "path", "index",
  "query", "result", "results", "search", "find", "create", "update",
  "delete", "remove", "add", "list", "check", "test", "run", "build",
]);

const TEST_PATH_PATTERNS = [
  /(?:^|[/\\])tests?[/\\]/i,
  /(?:^|[/\\])__tests__[/\\]/i,
  /(?:^|[/\\])spec[/\\]/i,
  /\.(?:test|spec)\.[^/\\]+$/i,
  /(?:^|[/\\])test_[^/\\]*$/i,
];

/** Extract identifiers whose spelling carries an explicit code-form signal. */
export function extractCodeIdentifiers(query: string): string[] {
  return [...new Set((query.match(CODE_IDENTIFIER_RE) ?? []).filter((value) => {
    if (
      value.length < 3 ||
      CODE_IDENTIFIER_STOP_WORDS.has(value.toLowerCase())
    ) return false;
    return /[A-Z]/.test(value) || value.includes("_") || value.includes(".");
  }))];
}

/**
 * Keep definition reranking away from constant mentions such as `STATIC_URL`.
 * Those frequently describe behavior at a use site rather than a request for
 * the defining file.
 */
export function extractDefinitionIdentifiers(query: string): string[] {
  return extractCodeIdentifiers(query).filter((value) =>
    !/^[A-Z][A-Z0-9_]*$/.test(value)
  );
}

/** Recognize conventional test files without assuming a language or source root. */
export function isTestSourcePath(path: string): boolean {
  return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Compile project-relative globs with v1-compatible directory-suffix matching. */
export function generatedPathMatcher(
  patterns: readonly string[],
): (path: string) => boolean {
  const normalizedPatterns = patterns.map((pattern) =>
    pattern.replaceAll("\\", "/").replace(/^\.\//, "")
  );
  const globs = [...new Set(normalizedPatterns.flatMap((pattern) =>
    pattern.startsWith("**/") ? [pattern] : [pattern, `**/${pattern}`]
  ))].map((pattern) => new Bun.Glob(pattern));
  return globs.length === 0
    ? () => false
    : (path) => {
      const normalizedPath = path.replaceAll("\\", "/").replace(/^\.\//, "");
      return globs.some((glob) => glob.match(normalizedPath));
    };
}
