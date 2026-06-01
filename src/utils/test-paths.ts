/**
 * Shared test-path detection. Two callers need the same definition:
 *   - search ranking demotes test files ([src/search/hybrid.ts]);
 *   - the `impact` tool surfaces test files to run.
 * Keeping one source of truth avoids the two drifting apart.
 */

/** Path patterns that identify a test file. */
export const TEST_PATTERNS: RegExp[] = [
  /(?:^|[/\\])tests?[/\\]/i,
  /(?:^|[/\\])__tests__[/\\]/i,
  /(?:^|[/\\])spec[/\\]/i,
  /\.(?:test|spec)\.[^/\\]+$/i,
  /(?:^|[/\\])test_/i,
];

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(path));
}
