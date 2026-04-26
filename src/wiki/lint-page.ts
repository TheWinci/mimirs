/**
 * Cheap, zero-LLM lint for generated wiki pages. Catches the classes of drift
 * that show up most often: fabricated file paths and Mermaid node IDs that
 * collide with reserved keywords.
 *
 * Purely pattern-based — no AST, no DB. Runs fast over the whole wiki in
 * milliseconds. Warnings are advisory: the LLM can fix them in place during
 * finalize.
 */

/**
 * Mermaid reserved tokens that silently break rendering when used as bare
 * node IDs. Covers flowchart, direction, and class styling keywords across
 * common diagram types.
 */
const MERMAID_RESERVED_IDS = new Set([
  "graph",
  "subgraph",
  "end",
  "flowchart",
  "direction",
  "classdef",
  "class",
  "style",
  "linkstyle",
  "click",
  "default",
  "tb",
  "td",
  "bt",
  "rl",
  "lr",
  "le",
]);

export type LintWarningKind =
  | "missing-file"
  | "constant-missing"
  | "constant-value-drift"
  | "constant-uncited"
  | "member-uncited"
  | "line-range-drift"
  | "citation-symbol-drift"
  | "prose-hedge"
  | "mermaid-reserved-id"
  | "mermaid-unquoted-label"
  | "mermaid-html-in-alias";

/**
 * Project constant — a top-level `NAME = value` declaration. Value is the raw
 * snippet (trimmed, first line). Used by the constant check to flag prose
 * that cites a stale value.
 */
export interface ProjectConstant {
  name: string;
  value: string;
  file: string;
}

export interface PageLintWarning {
  kind: LintWarningKind;
  message: string;
  /** 1-indexed line in the markdown where the issue was detected. */
  line: number;
  /** The offending token/path/id verbatim. */
  match: string;
  /**
   * Authoritative replacement suggestion when the warning has one — e.g.
   * `"src/db/index.ts:120-180"` for a `line-range-drift` that should be
   * rewritten to cover the current enclosing symbol. Allows a batch-fix
   * pass to substitute the token without re-parsing source.
   */
  correctedMatch?: string;
}

/**
 * Tree-sitter chunk range for one symbol in a file — keyed by path in
 * `LintPageOptions.chunkRangesByPath`. Comes from the indexer's chunker
 * (`bun-chunk`), so ranges are language-agnostic and always match HEAD.
 */
export interface ChunkRange {
  entityName: string | null;
  chunkType: string | null;
  startLine: number;
  endLine: number;
}

export interface LintPageOptions {
  /**
   * Set of project-relative file paths (same form as `bundle.memberFiles`).
   * When provided, backticked `path.ext` tokens and `path:N-M` references
   * are checked against this set. When absent, path validation is skipped.
   *
   * Line ranges inside `path:N-M` citations are NOT validated — only the
   * path existence is. Drift checks caused agents to re-read entire files
   * to reconcile citations that were cosmetically stale but semantically
   * fine, so the numeric check was removed.
   */
  knownFilePaths?: Set<string>;
  /**
   * Map of `CONSTANT_NAME → { value, file }`. Prose of the form
   * `` `FOO = 0.7` `` is matched against this map:
   *   - name missing → `constant-missing`
   *   - name present but value differs → `constant-value-drift`
   *
   * Only backticked occurrences are checked to avoid false-positives on
   * glosses like "roughly 70%". Absent → constant check is skipped.
   */
  knownConstants?: Map<string, ProjectConstant>;
  /**
   * Constants the page is expected to cite — the community bundle's
   * `tunables[]`, scoped to this page's member files for sub-pages. When a
   * name doesn't appear as a backticked reference anywhere on the page (prose
   * OR fenced code — code samples that cite a constant still count), a
   * `constant-uncited` warning fires.
   *
   * Prevents silent coverage regressions: every new tunable added to source
   * must appear somewhere under the owning community's page tree. Absent →
   * coverage check is skipped.
   */
  expectedConstants?: ProjectConstant[];
  /**
   * Member files the page is expected to name. A member is "cited" when its
   * exact project-relative path appears as a backticked reference anywhere
   * on the page (prose or fenced code). Fires `member-uncited` for each
   * missing member.
   *
   * Targets the coverage symptom v2's Louvain folding was docked on: when a
   * community absorbs small modules (`conversation/`, `graph/resolver.ts`),
   * the resulting page can silently omit them. Requiring every member to
   * appear by path forces them into per-file-breakdown, dependency tables,
   * or diagrams — wherever makes sense. Absent → check is skipped.
   */
  expectedMembers?: string[];
  /**
   * Tree-sitter chunk ranges keyed by project-relative path. Feeds the
   * `line-range-drift` check: for every cited `path:L1-L2`, find the
   * chunk whose range covers `L1`. If the stored `[start, end]` differs,
   * the lint emits a warning with `correctedMatch = "path:start-end"` so
   * a batch-fix pass can substitute the right citation. Absent → drift
   * check is skipped. Language-agnostic — ranges come from the indexer,
   * so this works wherever mimirs indexes.
   */
  chunkRangesByPath?: Map<string, ChunkRange[]>;
}

export function lintPage(
  markdown: string,
  opts: LintPageOptions = {},
): PageLintWarning[] {
  const warnings: PageLintWarning[] = [];
  const lines = markdown.split("\n");

  lintPathRefs(lines, opts, warnings);
  lintConstants(lines, opts, warnings);
  lintConstantCoverage(markdown, opts, warnings);
  lintMemberCoverage(markdown, opts, warnings);
  lintCitationSymbols(lines, opts, warnings);
  lintHedgeWords(lines, warnings);
  lintMermaidBlocks(lines, warnings);

  return warnings;
}

/**
 * Hedge / marketing words that drag prose quality down. Reviewer rubric:
 * zero hits across all pages targets a 10/10 prose score. Pattern is
 * conservative — only the eight tokens explicitly called out, plus their
 * obvious morphs (`leverages`, `robustly`). Code fences are skipped so
 * legitimate identifier matches (`leverageScore`) don't fire.
 */
const HEDGE_WORD_RE =
  /\b(basically|simply|just|really|leverag(?:e|es|ed|ing)|robust(?:ly|ness)?|seamless(?:ly)?|powerful(?:ly)?)\b/gi;

function lintHedgeWords(lines: string[], warnings: PageLintWarning[]): void {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(HEDGE_WORD_RE)) {
      warnings.push({
        kind: "prose-hedge",
        message:
          `hedge / marketing word \`${m[0]}\` — drop or replace with a concrete claim`,
        line: i + 1,
        match: m[0],
      });
    }
  }
}

/**
 * Match patterns where a backticked symbol is directly attributed to a
 * `path:line[-line]` citation. Three writer conventions are covered:
 *   - `` `name()` (path:1-2) ``
 *   - `` `name` — path:1-2 ``
 *   - `` `name` at path:1-2 ``
 *
 * The lint is intentionally narrow — only fires when the symbol is sitting
 * next to the citation. Loose proximity ("name appears somewhere on the
 * same line as the citation") drowns the warning channel in false positives
 * (writers cite chains of related symbols in a single sentence).
 */
const ATTRIBUTED_CITATION_RE =
  /`([A-Za-z_][A-Za-z0-9_]*)\(?\)?`(?:\s*\(\s*|\s*[—-]\s*|\s+at\s+)([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}):(\d+)(?:-(\d+))?/g;

const CITATION_TOLERANCE_LINES = 3;

/**
 * Symbol-citation drift check. For every backticked symbol attributed to a
 * `path:line` range, verify the symbol appears as an entity name in some
 * chunk overlapping the cited range (± CITATION_TOLERANCE_LINES). When the
 * symbol is missing, emit `citation-symbol-drift` and surface the actual
 * entity names found at that range so a fix pass can substitute the right
 * symbol or correct the range. Skipped when chunk ranges or known paths
 * are unavailable.
 */
function lintCitationSymbols(
  lines: string[],
  opts: LintPageOptions,
  warnings: PageLintWarning[],
): void {
  if (!opts.chunkRangesByPath || !opts.knownFilePaths) return;
  const known = opts.knownFilePaths;
  const basenameIndex = buildBasenameIndex(known);

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const m of line.matchAll(ATTRIBUTED_CITATION_RE)) {
      const symbol = m[1];
      const path = m[2];
      if (!isPlausiblePath(path)) continue;
      const resolved = resolvePathRef(path, known, basenameIndex);
      if (!resolved) continue;
      const ranges = opts.chunkRangesByPath.get(resolved);
      if (!ranges || ranges.length === 0) continue;

      const citedStart = parseInt(m[3], 10);
      const citedEnd = m[4] ? parseInt(m[4], 10) : citedStart;
      if (!Number.isFinite(citedStart)) continue;

      const nearbyEntities: string[] = [];
      for (const r of ranges) {
        if (r.endLine < citedStart - CITATION_TOLERANCE_LINES) continue;
        if (r.startLine > citedEnd + CITATION_TOLERANCE_LINES) continue;
        if (r.entityName) nearbyEntities.push(r.entityName);
      }
      if (nearbyEntities.length === 0) continue;
      if (nearbyEntities.includes(symbol)) continue;

      const rangeToken = m[4] ? `${path}:${m[3]}-${m[4]}` : `${path}:${m[3]}`;
      const found = nearbyEntities.slice(0, 3).join(", ");
      warnings.push({
        kind: "citation-symbol-drift",
        message:
          `cited symbol \`${symbol}\` not found within ±${CITATION_TOLERANCE_LINES} lines of \`${rangeToken}\` — ` +
          `entities at that range: ${found}`,
        line: i + 1,
        match: `${symbol} @ ${rangeToken}`,
      });
    }
  }
}

/**
 * Coverage pass — flags member files the page was expected to name but
 * didn't. Mirrors `lintConstantCoverage` but for paths: every entry in
 * `expectedMembers` must appear as a backticked citation somewhere in the
 * rendered markdown. Code samples count — a member named inside a fenced
 * block is still "cited".
 *
 * The bundle passes the community's memberFiles here so the page cannot
 * silently omit one. Catches the Louvain-folding symptom in the v2
 * review: small modules absorbed into a parent community still need to
 * appear on the parent's page.
 */
function lintMemberCoverage(
  markdown: string,
  opts: LintPageOptions,
  warnings: PageLintWarning[],
): void {
  if (!opts.expectedMembers || opts.expectedMembers.length === 0) return;
  for (const path of opts.expectedMembers) {
    const needle = "`" + path + "`";
    if (markdown.includes(needle)) continue;
    warnings.push({
      kind: "member-uncited",
      message:
        `member file \`${path}\` is not cited anywhere on the page — ` +
        `name it at least once (per-file-breakdown row, dependency table, or diagram node)`,
      line: 1,
      match: path,
    });
  }
}

/**
 * Coverage pass — flags tunables the page was expected to cite but didn't.
 * Scans the full markdown for backticked uppercase identifiers (fence-aware
 * off: code samples still count as citations), then diffs against the
 * expected set. Complements `lintConstants` which catches wrong-value
 * citations; together they enforce prose ↔ source parity for tunables.
 */
function lintConstantCoverage(
  markdown: string,
  opts: LintPageOptions,
  warnings: PageLintWarning[],
): void {
  if (!opts.expectedConstants || opts.expectedConstants.length === 0) return;

  // A constant is "cited" if its exact SCREAMING_SNAKE_CASE name appears
  // anywhere on the page — prose, backticked, or inside a fenced code sample.
  // A code block that shows `const FOO = 0.7` is a perfectly valid way to
  // surface the tunable, so we don't require inline backticks.
  for (const c of opts.expectedConstants) {
    const nameRe = new RegExp(`\\b${escapeForRegex(c.name)}\\b`);
    if (nameRe.test(markdown)) continue;
    warnings.push({
      kind: "constant-uncited",
      message:
        `tunable \`${c.name}\` from \`${c.file}\` is not cited anywhere on the page — ` +
        `add a backticked reference with the literal value or regenerate the page`,
      line: 1,
      match: c.name,
    });
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pick the chunk whose `[startLine, endLine]` covers `line`. When multiple
 * chunks nest (e.g. a method inside a class), return the innermost match —
 * it's the "tightest" enclosing symbol and thus the most useful reference.
 * Assumes `ranges` is sorted by `startLine` ascending (the DB query
 * guarantees this).
 */
function findEnclosingChunk(
  ranges: ChunkRange[],
  line: number,
): ChunkRange | null {
  let best: ChunkRange | null = null;
  for (const r of ranges) {
    if (r.startLine <= line && line <= r.endLine) {
      if (!best || r.endLine - r.startLine < best.endLine - best.startLine) {
        best = r;
      }
    }
  }
  return best;
}

/**
 * Match `` `something.ext` `` and `path:N-M`. Backtick form is common in page
 * body; the colon form appears in cross-refs generated by the pipeline.
 */
const BACKTICK_PATH_RE = /`([A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,6})`/g;
const COLON_RANGE_RE = /\b([A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,6}):(\d+)(?:-(\d+))?\b/g;

/**
 * Whitelist of real file extensions we care about. Without this, the path
 * regex fires on method chains like `db.search` and `JSON.parse` because
 * `search`/`parse` match the generic `[A-Za-z0-9]{1,6}` extension pattern.
 */
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rs", "go", "java", "rb", "php", "swift", "kt", "scala",
  "c", "cpp", "cc", "cxx", "h", "hpp", "cs",
  "md", "mdx", "txt", "rst", "adoc",
  "json", "yaml", "yml", "toml", "ini", "xml",
  "html", "htm", "css", "scss", "sass", "less",
  "sh", "bash", "zsh", "fish",
  "sql", "graphql", "gql", "proto",
  "lock", "env",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "ico",
]);

function lintPathRefs(
  lines: string[],
  opts: LintPageOptions,
  warnings: PageLintWarning[],
): void {
  if (!opts.knownFilePaths) return;
  const known = opts.knownFilePaths;
  const basenameIndex = buildBasenameIndex(known);

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const m of line.matchAll(BACKTICK_PATH_RE)) {
      const path = m[1];
      if (!isPlausiblePath(path)) continue;
      if (resolvePathRef(path, known, basenameIndex)) continue;
      warnings.push({
        kind: "missing-file",
        message: `referenced path \`${path}\` not in project`,
        line: i + 1,
        match: path,
      });
    }

    for (const m of line.matchAll(COLON_RANGE_RE)) {
      const path = m[1];
      if (!isPlausiblePath(path)) continue;
      const resolved = resolvePathRef(path, known, basenameIndex);
      if (!resolved) {
        warnings.push({
          kind: "missing-file",
          message: `referenced path \`${path}\` not in project`,
          line: i + 1,
          match: path,
        });
        continue;
      }
      // Line-range drift: compare the cited `[L1, L2]` against the chunk
      // that encloses L1 in the current source. Only runs when the caller
      // passes `chunkRangesByPath` — indexer-sourced, so a corrected value
      // is always available. Without ranges we skip rather than guess. Use
      // the basename-resolved path so a bare-filename citation still gets
      // drift-checked against the unique full path.
      const ranges = opts.chunkRangesByPath?.get(resolved);
      if (!ranges || ranges.length === 0) continue;
      const startStr = m[2];
      const endStr = m[3];
      const citedStart = parseInt(startStr, 10);
      const citedEnd = endStr ? parseInt(endStr, 10) : citedStart;
      if (!Number.isFinite(citedStart)) continue;
      const enclosing = findEnclosingChunk(ranges, citedStart);
      if (!enclosing) continue;
      if (enclosing.startLine === citedStart && enclosing.endLine === citedEnd) continue;
      const citedToken = endStr ? `${path}:${startStr}-${endStr}` : `${path}:${startStr}`;
      const correctedToken = `${path}:${enclosing.startLine}-${enclosing.endLine}`;
      warnings.push({
        kind: "line-range-drift",
        message:
          `citation \`${citedToken}\` drifted from the enclosing symbol's current range \`${correctedToken}\` — ` +
          `update the citation (auto-fixable via wiki_lint_batch)`,
        line: i + 1,
        match: citedToken,
        correctedMatch: correctedToken,
      });
    }
  }
}

/**
 * Match `` `NAME = value` `` where NAME is a SCREAMING_SNAKE_CASE identifier.
 * Intentionally restricted to uppercase to avoid firing on arbitrary prose
 * like `` `db.search = fn` `` or inline code samples. The backtick constraint
 * kills glosses such as "roughly 70%" — only verbatim literal citations are
 * checked.
 */
const CONSTANT_REF_RE = /`([A-Z][A-Z0-9_]*)\s*=\s*([^`]+?)`/g;

function lintConstants(
  lines: string[],
  opts: LintPageOptions,
  warnings: PageLintWarning[],
): void {
  if (!opts.knownConstants) return;
  const constants = opts.knownConstants;

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    for (const m of line.matchAll(CONSTANT_REF_RE)) {
      const name = m[1];
      const citedValue = m[2].trim();
      const known = constants.get(name);
      if (!known) {
        warnings.push({
          kind: "constant-missing",
          message: `cited constant \`${name}\` not found as an exported symbol in the project`,
          line: i + 1,
          match: name,
        });
        continue;
      }
      if (!constantValuesMatch(citedValue, known.value)) {
        warnings.push({
          kind: "constant-value-drift",
          message:
            `cited value for \`${name}\` (\`${citedValue}\`) differs from source in \`${known.file}\` ` +
            `(\`${known.value}\`) — update the citation or regenerate the page`,
          line: i + 1,
          match: `${name} = ${citedValue}`,
        });
      }
    }
  }
}

/**
 * Compare a prose-cited literal against the source snippet. The source-side
 * value is the raw chunk snippet (which often includes type annotations and
 * trailing punctuation), so we extract the first `= ...` run and compare
 * normalized forms. False-negatives on exotic formats (multi-line initializers)
 * are preferred over false-positives — the lint is advisory.
 */
function constantValuesMatch(cited: string, sourceSnippet: string): boolean {
  const sourceValue = extractValueFromSnippet(sourceSnippet);
  if (sourceValue === null) return true; // can't parse — skip rather than false-positive
  return normalizeLiteral(cited) === normalizeLiteral(sourceValue);
}

function extractValueFromSnippet(snippet: string): string | null {
  const firstLine = snippet.split("\n")[0] ?? "";
  const eqIdx = firstLine.indexOf("=");
  if (eqIdx < 0) return null;
  let tail = firstLine.slice(eqIdx + 1).trim();
  // Strip trailing semicolon / comma / comment noise.
  tail = tail.replace(/\s*\/\/.*$/, "").replace(/[;,]$/, "").trim();
  return tail.length > 0 ? tail : null;
}

function normalizeLiteral(s: string): string {
  return s.replace(/\s+/g, "").replace(/['"]/g, "").toLowerCase();
}

/**
 * Index `knownFilePaths` by basename → list of full paths. Used to resolve
 * bare-filename backtick refs (e.g. `wiki-tools.ts`) against the actual
 * project path (`src/tools/wiki-tools.ts`) so the lint stops false-flagging
 * shorthand citations as missing-file. Built once per `lintPage` call.
 */
function buildBasenameIndex(known: Set<string>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const p of known) {
    const slash = p.lastIndexOf("/");
    const base = slash < 0 ? p : p.slice(slash + 1);
    if (base === p) continue; // bare path entries already match by direct lookup
    const list = idx.get(base);
    if (list) list.push(p);
    else idx.set(base, [p]);
  }
  return idx;
}

/**
 * Resolve a backticked path ref to a full known path, or `null` if no match.
 * Direct hit on `knownFilePaths` wins; bare-filename refs fall back to the
 * basename index (only when exactly one project file shares the basename —
 * ambiguous shorthand still resolves silently to "exists somewhere", which
 * is the right call: a writer using `chunker.ts` to mean any of two homonym
 * files is a prose problem, not a path-existence problem).
 */
function resolvePathRef(
  ref: string,
  known: Set<string>,
  basenameIndex: Map<string, string[]>,
): string | null {
  if (known.has(ref)) return ref;
  if (ref.includes("/")) return null;
  const candidates = basenameIndex.get(ref);
  if (!candidates || candidates.length === 0) return null;
  return candidates.length === 1 ? candidates[0] : ref;
}

/**
 * A plausible project-relative path has a whitelisted extension AND either
 * contains a `/` (directory path) or is a bare filename. Rejecting on the
 * extension whitelist is the primary filter: `db.search`, `log.warn`,
 * `JSON.parse`, `process.argv` all vanish because their trailing token is
 * a method name, not a real file extension. We also reject tokens that
 * begin with `.` unless followed by `/` — kills `.ts/.tsx/.js/.jsx` and
 * similar bare-extension lists written in docs.
 */
function isPlausiblePath(s: string): boolean {
  const lastDot = s.lastIndexOf(".");
  if (lastDot < 0) return false;
  const ext = s.slice(lastDot + 1).toLowerCase();
  if (!CODE_EXTENSIONS.has(ext)) return false;

  // Reject leading `.` unless it's a relative prefix (`./foo.ts`).
  if (s.startsWith(".") && !s.startsWith("./")) return false;

  if (s.includes("/")) return true;
  // Single-file ref (e.g., `README.md`, `package.json`).
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}$/.test(s);
}

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}

/**
 * HTML tokens that break Mermaid rendering when they appear in participant
 * aliases (Mermaid 10+) or inside `[...]`/`(...)`/`{...}` labels. `<br/>` is
 * the most common real-world hit — writers reach for it to wrap long labels
 * and silently break the diagram.
 */
const MERMAID_HTML_TOKENS = [/<br\s*\/?>/i, /<b>/i, /<i>/i, /&nbsp;/i];

/**
 * Scan ```mermaid``` blocks. Extract tokens that appear in node-id position
 * and flag any that match a Mermaid reserved keyword.
 *
 * Node-id position heuristics (conservative — avoid false positives):
 *   - Token at line start followed by `[`, `(`, `{`, or `>` (label delimiters)
 *   - Token on either side of `-->`, `---`, `-.->`, `==>`, `~~~` (edge arrows)
 */
function lintMermaidBlocks(lines: string[], warnings: PageLintWarning[]): void {
  let inMermaid = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceOpen = /^\s*```mermaid\s*$/i.test(line);
    const fenceClose = /^\s*```\s*$/.test(line);

    if (!inMermaid && fenceOpen) {
      inMermaid = true;
      continue;
    }
    if (inMermaid && fenceClose) {
      inMermaid = false;
      continue;
    }
    if (!inMermaid) continue;

    // Skip blank lines, comments. Directive lines (`graph TD`, `flowchart LR`,
    // `subgraph Name`) don't carry brackets or arrows, so `extractNodeIds`
    // will return nothing for them — no explicit filter needed.
    if (/^\s*$/.test(line) || /^\s*%%/.test(line)) continue;

    for (const id of extractNodeIds(line)) {
      const lower = id.toLowerCase();
      if (MERMAID_RESERVED_IDS.has(lower)) {
        warnings.push({
          kind: "mermaid-reserved-id",
          message: `Mermaid node id \`${id}\` is a reserved keyword — rename to avoid silent render break`,
          line: i + 1,
          match: id,
        });
      }
    }

    for (const label of extractUnquotedLabels(line)) {
      warnings.push({
        kind: "mermaid-unquoted-label",
        message:
          `Mermaid label \`${label}\` contains path/punctuation chars and is not quoted — ` +
          `wrap in double quotes (e.g. \`A["${label}"]\`) to avoid render breakage`,
        line: i + 1,
        match: label,
      });
    }

    for (const hit of extractHtmlInAlias(line)) {
      warnings.push({
        kind: "mermaid-html-in-alias",
        message:
          `Mermaid label/alias contains HTML token \`${hit}\` — breaks rendering in Mermaid 10+ ` +
          `(especially inside \`participant X as\` aliases). Remove the tag; put detail in prose or shorten the label.`,
        line: i + 1,
        match: hit,
      });
    }
  }
}

/**
 * Returns HTML tokens found inside Mermaid label carriers on this line:
 *   - `participant X as "..."` or `participant X as ...`
 *   - `[...]`, `(...)`, `{...}` brackets anywhere in the line
 *
 * Returns the matched tokens verbatim (first form, e.g., `<br/>`) so warnings
 * echo what the writer typed.
 */
function extractHtmlInAlias(line: string): string[] {
  const out: string[] = [];

  // participant aliases — check everything after `as `.
  const participantMatch = /\bparticipant\s+[A-Za-z_][A-Za-z0-9_]*\s+as\s+(.*)$/i.exec(line);
  if (participantMatch) {
    for (const re of MERMAID_HTML_TOKENS) {
      const m = re.exec(participantMatch[1]);
      if (m) out.push(m[0]);
    }
  }

  // Bracketed labels anywhere on the line.
  for (const m of line.matchAll(/[\[({]([^\[\](){}]*)[\])}]/g)) {
    for (const re of MERMAID_HTML_TOKENS) {
      const hit = re.exec(m[1]);
      if (hit) out.push(hit[0]);
    }
  }

  return out;
}

/**
 * Match unquoted Mermaid label contents that contain characters likely to
 * break rendering: `/`, `.`, `(`, `)`, `<`, `>`, `|`, `:`, whitespace, or
 * `-` as a free-standing dash (common in filenames). Covers four label
 * carriers: `[...]`, `(...)`, `{...}`, and `as <label>` in sequence diagrams.
 *
 * Intentionally narrow — bare single-word labels (no special chars) stay
 * unflagged so we don't drown in noise from plain node ids.
 */
const RISKY_LABEL_CHARS = /[\/().<>|:\s]/;
const LABEL_BRACKET_RE = /[\[({]([^\[\](){}"]+)[\])}]/g;
const LABEL_AS_RE = /\bas\s+([^"\n\r|]+?)(?=\s*(?:$|--|==|\.\.|-\.|~~|\||[\[({]))/g;

function extractUnquotedLabels(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(LABEL_BRACKET_RE)) {
    const inner = m[1].trim();
    if (!inner) continue;
    if (RISKY_LABEL_CHARS.test(inner)) out.push(inner);
  }
  for (const m of line.matchAll(LABEL_AS_RE)) {
    const inner = m[1].trim();
    if (!inner) continue;
    if (inner.startsWith("\"")) continue;
    if (RISKY_LABEL_CHARS.test(inner)) out.push(inner);
  }
  return out;
}

/**
 * Pull node-id candidates out of a Mermaid content line. Returns unique tokens
 * detected in node-id position. Intentionally narrow — misses exotic syntax
 * but stays noise-free.
 */
function extractNodeIds(line: string): string[] {
  const ids = new Set<string>();

  // Leading id followed by a label opener: `foo[...]`, `foo(...)`, `foo{...}`, `foo>...]`.
  const leading = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?:\[|\(|\{|>)/);
  if (leading) ids.add(leading[1]);

  // Edge forms: `A --> B`, `A --- B`, `A -.-> B`, `A ==> B`, `A ~~~ B`,
  // `A -->|label| B`, `A --> B[label]`. Capture both sides.
  const edgeRe =
    /([A-Za-z_][A-Za-z0-9_-]*)\s*(?:-{2,3}>?|-\.-+>?|={2,}>?|~{3})(?:\|[^|]*\|)?\s*([A-Za-z_][A-Za-z0-9_-]*)/g;
  for (const m of line.matchAll(edgeRe)) {
    ids.add(m[1]);
    ids.add(m[2]);
  }

  return [...ids];
}
