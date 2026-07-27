import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "html");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

function imports(
  values: Awaited<ReturnType<typeof result>>["facts"],
): ImportFact[] {
  return values.filter((fact): fact is ImportFact => fact.kind === "import");
}

describe("HTML source facts", () => {
  test("preserves scripts, stylesheets, preloads, and image resources", async () => {
    expect(
      imports((await result("document.html")).facts).map((fact) => [
        fact.source,
        fact.imported,
        fact.owner?.name,
      ]),
    ).toEqual([
      ["/app.css", "stylesheet", "head"],
      ["/feature.js", "modulepreload", "head"],
      ["/app.js", "script", "head"],
      ["hero.png", "asset:img.src", "main"],
    ]);
  });

  test("preserves media, embedded-document, object, and SVG asset references", async () => {
    expect(
      imports((await result("assets.html")).facts).map((fact) => [
        fact.source,
        fact.imported,
      ]),
    ).toEqual([
      ["movie.mp4", "asset:video.src"],
      ["poster.jpg", "asset:video.poster"],
      ["sound.mp3", "asset:audio.src"],
      ["frame.html", "asset:iframe.src"],
      ["diagram.svg", "asset:object.data"],
      ["icons.svg#add", "asset:use.href"],
      ["button.png", "asset:input.src"],
    ]);
  });

  test("does not invent dependencies for templates, data URIs, navigation, or forms", async () => {
    expect((await result("dynamic.html")).facts).toEqual([]);
  });

  test("does not parse inline script or style text as HTML calls or imports", async () => {
    const values = (await result("document.html")).facts;
    expect(values.some((fact) => fact.kind === "call")).toBe(false);
    expect(
      imports(values).some((fact) => fact.source.includes("initialize")),
    ).toBe(false);
  });

  test("keeps void and self-closing elements on their actual line", async () => {
    const document = await result("document.html");
    const html = document.chunks.find((chunk) => chunk.name === "html")!;
    const head = html.children.find((chunk) => chunk.name === "head")!;
    expect(
      head.children
        .filter((chunk) => chunk.name === "link")
        .map((chunk) => [chunk.startLine, chunk.endLine]),
    ).toEqual([
      [4, 4],
      [5, 5],
    ]);
  });

  test("routes the .htm extension through reviewed HTML support", async () => {
    expect((await result("comments.htm")).language).toBe("html");
  });

  test("does not fabricate HTML export facts", async () => {
    expect(
      (await result("document.html")).facts.some(
        (fact) => fact.kind === "export",
      ),
    ).toBe(false);
  });

  test("HTML-E1 preserves responsive candidates, rel tokens, and SVG resources", async () => {
    expect(imports((await result("responsive.html")).facts).map((fact) => [
      fact.source,
      fact.imported,
      fact.owner?.name ?? null,
    ])).toEqual([
      ["small.webp", "asset:source.srcset", "picture"],
      ["images/photo,wide.webp", "asset:source.srcset", "picture"],
      ["fallback.png", "asset:img.src", "picture"],
      ["small.png", "asset:img.srcset", "picture"],
      ["large.png", "asset:img.srcset", "picture"],
      ["responsive.css", "stylesheet", "main"],
      ["responsive.css", "preload", "main"],
      ["preview.png", "asset:link.imagesrcset", "main"],
      ["diagram.svg", "asset:image.href", "svg"],
      ["icons.svg#check", "asset:use.xlink:href", "svg"],
    ]);
  });
});
