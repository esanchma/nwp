import { describe, expect, test } from "bun:test";
import { decodeCursor, decodeSearchCursor, encodeCursor, encodeSearchCursor, extractWikiLinks, normalizeTags, slugify, validateAlias } from "../src/domain.ts";
import { renderMarkdown } from "../src/markdown.ts";

describe("domain helpers", () => {
  test("creates ASCII aliases", () => {
    expect(slugify("Guía de Instalación  rápida")).toBe("guia-de-instalacion-rapida");
    expect(slugify("日本語")).toBe("page");
    expect(validateAlias("valid-page-2")).toBe("valid-page-2");
    expect(() => validateAlias("Not valid")).toThrow();
  });

  test("normalizes and deduplicates tags", () => {
    expect(normalizeTags([" Bun ", "wiki", "BUN", ""])).toEqual(["bun", "wiki"]);
  });

  test("extracts unique valid wiki-links", () => {
    expect(extractWikiLinks("[[home]] [[guide|the guide]] [[home]] [[Not valid]]")).toEqual(["home", "guide"]);
  });

  test("round-trips cursors and rejects bad cursors", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
    expect(decodeSearchCursor(encodeSearchCursor(20))).toBe(20);
    expect(() => decodeCursor("not-an-id")).toThrow();
    expect(() => decodeSearchCursor(encodeCursor(20))).toThrow();
  });
});

describe("Markdown", () => {
  test("renders existing and missing wiki-links", () => {
    const html = renderMarkdown("See [[home]] and [[missing]].", (alias) => alias === "home");
    expect(html).toContain('href="/wiki/home"');
    expect(html).toContain('class="wikilink missing"');
    expect(html).toContain("/new?");
  });

  test("renders links to deleted pages", () => {
    const html = renderMarkdown("See [[gone]].", () => ({ state: "deleted", id: 7 }));
    expect(html).toContain('class="wikilink deleted"');
    expect(html).toContain('href="/trash/7"');
  });

  test("sanitizes active HTML", () => {
    const html = renderMarkdown('<script>alert(1)</script><a href="javascript:alert(1)" onclick="x()">bad</a>', () => false);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
  });

  test("does not expand wiki-links inside code", () => {
    const html = renderMarkdown("`[[home]]`", () => true);
    expect(html).toContain("<code>[[home]]</code>");
    expect(html).not.toContain("/wiki/home");
  });
});
