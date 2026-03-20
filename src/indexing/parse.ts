import matter from "gray-matter";
import { readFile } from "fs/promises";
import { extname } from "path";

export interface ParsedFile {
  path: string;
  content: string;
  frontmatter: Record<string, unknown> | null;
  extension: string;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

// Files with no real extension matched by exact basename.
const EXACT_NAME_MAP = new Map<string, string>([
  ["makefile", ".makefile"],
  ["gnumakefile", ".makefile"],
  ["vagrantfile", ".vagrantfile"],
  ["gemfile", ".gemfile"],
  ["rakefile", ".rakefile"],
  ["brewfile", ".brewfile"],
  ["procfile", ".procfile"],
]);

// Files whose basename starts with a known prefix (e.g. Dockerfile.dev,
// Jenkinsfile.staging). Each entry is [lowerPrefix, virtualExtension].
const PREFIX_NAME_MAP: [string, string][] = [
  ["dockerfile", ".dockerfile"],
  ["jenkinsfile", ".jenkinsfile"],
];

function resolveExtension(rawExt: string, basename: string): string {
  if (rawExt) {
    // Even with an extension, check prefixes: Dockerfile.dev should win.
    for (const [prefix, virtualExt] of PREFIX_NAME_MAP) {
      if (basename === prefix || basename.startsWith(prefix + ".")) {
        return virtualExt;
      }
    }
    return rawExt;
  }
  // No extension — check exact names first, then prefixes.
  if (EXACT_NAME_MAP.has(basename)) return EXACT_NAME_MAP.get(basename)!;
  for (const [prefix, virtualExt] of PREFIX_NAME_MAP) {
    if (basename === prefix || basename.startsWith(prefix + ".")) {
      return virtualExt;
    }
  }
  return rawExt;
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
  const raw = await readFile(filePath, "utf-8");
  const rawExt = extname(filePath).toLowerCase();
  const basename = filePath.split("/").pop()?.toLowerCase() ?? "";
  const ext = resolveExtension(rawExt, basename);

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    const { data, content } = matter(raw);
    const hasFrontmatter = Object.keys(data).length > 0;
    return {
      path: filePath,
      content: hasFrontmatter
        ? buildWeightedText(data, content)
        : content.trim(),
      frontmatter: hasFrontmatter ? data : null,
      extension: ext,
    };
  }

  return {
    path: filePath,
    content: raw.trim(),
    frontmatter: null,
    extension: ext,
  };
}

function buildWeightedText(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const parts: string[] = [];

  if (frontmatter.name) parts.push(`${frontmatter.name}`);
  if (frontmatter.description)
    parts.push(`description: ${frontmatter.description}`);
  if (frontmatter.type) parts.push(`type: ${frontmatter.type}`);
  if (frontmatter.tags) {
    const tags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags.join(", ")
      : frontmatter.tags;
    parts.push(`tags: ${tags}`);
  }

  if (body.trim()) parts.push(body.trim());

  return parts.join("\n");
}
