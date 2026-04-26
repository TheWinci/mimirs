import { relative, dirname } from "path";
import type {
  PageManifest,
  ManifestPage,
  ContentCache,
  PagePayload,
  PageContentCache,
} from "./types";
import { semanticQueriesFor } from "./semantic-queries";

/**
 * Focused payload for a single page, returned by `generate_wiki(page: N)`.
 *
 * Sections come from the synthesis (community pages) or the static seed
 * (architecture, getting-started). Prefetched data is whichever bundle
 * applies for this page's kind.
 */
export function buildPagePayload(
  pageIndex: number,
  manifest: PageManifest,
  content: ContentCache,
): PagePayload {
  const entries = Object.entries(manifest.pages)
    .sort(([, a], [, b]) => a.order - b.order);

  if (pageIndex < 0 || pageIndex >= entries.length) {
    throw new Error(`Page index ${pageIndex} out of range (0-${entries.length - 1})`);
  }

  const [wikiPath, page] = entries[pageIndex];
  const prefetched = content[wikiPath] ?? {};
  const linkMap = buildLinkMap(wikiPath, page, prefetched, manifest);
  const breadcrumbs = buildBreadcrumbs(wikiPath, manifest);
  const preRendered = {
    breadcrumb: renderBreadcrumbLine(breadcrumbs),
    seeAlso: renderSeeAlsoBlock(wikiPath, page.relatedPages, manifest),
  };

  return {
    wikiPath,
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    purpose: page.purpose,
    depth: page.depth,
    sections: page.sections,
    prefetched,
    relatedPages: page.relatedPages,
    linkMap,
    generatedFrom: manifest.lastGitRef,
    breadcrumbs,
    semanticQueries: semanticQueriesFor(page.kind),
    prefetchedQueries: prefetched.prefetchedQueries ?? [],
    preRendered,
  };
}

/**
 * Assemble the `> [Parent](..) › [Grand](..)` trail used at the top of
 * sub-pages. Top-level pages return an empty string — they have no parent
 * to navigate back to. The trail is rendered as a Markdown blockquote so
 * it reads as a header stripe rather than a first-class paragraph.
 */
function renderBreadcrumbLine(
  breadcrumbs: { title: string; relPath: string }[],
): string {
  if (breadcrumbs.length === 0) return "";
  const trail = breadcrumbs
    .map((c) => `[${c.title}](${c.relPath})`)
    .join(" › ");
  return `> ${trail}`;
}

/**
 * Assemble the "## See also" block — one bullet per related page, link
 * text from the manifest title, path relative to the current page's dir.
 * Returns an empty string when a page has no related pages so callers can
 * concatenate unconditionally without producing a stub heading.
 *
 * Bullet order is title-sorted for determinism (keeps diffs stable across
 * regenerations when the manifest iteration order shifts).
 */
function renderSeeAlsoBlock(
  currentWikiPath: string,
  relatedPages: string[],
  manifest: PageManifest,
): string {
  if (relatedPages.length === 0) return "";
  const fromDir = dirname(currentWikiPath);
  const rows: { title: string; relPath: string }[] = [];
  for (const rp of relatedPages) {
    const target = manifest.pages[rp];
    if (!target) continue;
    rows.push({ title: target.title, relPath: relative(fromDir, rp) });
  }
  if (rows.length === 0) return "";
  rows.sort((a, b) => a.title.localeCompare(b.title));
  const body = rows.map((r) => `- [${r.title}](${r.relPath})`).join("\n");
  return `## See also\n\n${body}`;
}

/**
 * Build the breadcrumb trail for a sub-page. Walks up from the page's
 * directory, stopping at each parent wiki path present in the manifest, and
 * ends with the architecture root. Top-level pages (directly under `wiki/`)
 * get an empty trail — no breadcrumb renders on the root.
 */
function buildBreadcrumbs(
  wikiPath: string,
  manifest: PageManifest,
): { title: string; relPath: string }[] {
  const fromDir = dirname(wikiPath);
  const crumbs: { title: string; relPath: string }[] = [];

  // Pages nested under `communities/foo/bar.md` resolve to ancestors
  // `communities/foo.md`, `communities.md` (if present), etc.
  const segments = wikiPath.split("/");
  for (let i = segments.length - 2; i >= 0; i--) {
    const parent = segments.slice(0, i).concat(segments[i] + ".md").join("/");
    const page = manifest.pages[parent];
    if (page) {
      crumbs.unshift({
        title: page.title,
        relPath: relative(fromDir, parent),
      });
    }
  }

  // Every page deeper than the wiki root gets the architecture crumb at the
  // front — even when intermediate parent pages are missing from the manifest
  // — so readers always have a one-click route back to the top. Top-level
  // pages (single-segment wikiPath) stay crumb-free.
  const isSubPage = segments.length > 1;
  if (!isSubPage) return [];

  // Manifest pages are keyed `wiki/<slug>.md`, not bare `<slug>.md` — the
  // earlier hard-coded `"architecture.md"` lookup silently missed every
  // page (community + sub) and never prepended the architecture crumb.
  const archPath = "wiki/architecture.md";
  if (wikiPath !== archPath && manifest.pages[archPath] && !crumbs.some((c) => c.title === manifest.pages[archPath].title)) {
    crumbs.unshift({
      title: manifest.pages[archPath].title,
      relPath: relative(fromDir, archPath),
    });
  }

  return crumbs;
}

/**
 * Build a scoped link map: page title → relative path.
 *
 * Always include related pages. For community pages, also include any page
 * whose title matches an export name in the community bundle (lightweight
 * cross-linking between communities that reference each other's types).
 */
function buildLinkMap(
  currentWikiPath: string,
  page: ManifestPage,
  prefetched: PageContentCache,
  manifest: PageManifest,
): Record<string, string> {
  const fromDir = dirname(currentWikiPath);
  const map: Record<string, string> = {};

  const pathToTitle = new Map<string, string>();
  for (const [targetPath, targetPage] of Object.entries(manifest.pages)) {
    pathToTitle.set(targetPath, targetPage.title);
  }

  for (const rp of page.relatedPages) {
    const title = pathToTitle.get(rp);
    if (title && rp !== currentWikiPath) {
      map[title] = relative(fromDir, rp);
    }
  }

  // Lightweight cross-linking for community pages: if an export name matches
  // another page's title, include it too.
  if (prefetched.community) {
    const exportNames = new Set(prefetched.community.exports.map((e) => e.name));
    for (const [targetPath, targetPage] of Object.entries(manifest.pages)) {
      if (targetPath === currentWikiPath) continue;
      if (map[targetPage.title]) continue;
      if (exportNames.has(targetPage.title)) {
        map[targetPage.title] = relative(fromDir, targetPath);
      }
    }
  }

  return map;
}
